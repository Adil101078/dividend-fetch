const express = require('express')
const puppeteer = require('puppeteer')
const NodeCache = require('node-cache')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const compression = require('compression')
const cors = require('cors')

const app = express()
const PORT = process.env.PORT || 3000

// Configuration
const CONFIG = {
	cache: {
		ttl: parseInt(process.env.CACHE_TTL) || 60, // 1 minutes default
		checkPeriod: 5, // Check every 30 seconds for expired items
	},
	browser: {
		maxConcurrent: parseInt(process.env.MAX_CONCURRENT_BROWSERS) || 3,
		timeout: parseInt(process.env.BROWSER_TIMEOUT) || 30000,
		headless: 'new', // Use new headless mode
	},
	rateLimit: {
		windowMs: 15 * 60 * 1000, // 15 minutes
		max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
	},
}

// Initialize cache
const cache = new NodeCache({
	stdTTL: CONFIG.cache.ttl,
	checkperiod: CONFIG.cache.checkPeriod,
})

// Browser pool management
class BrowserPool {
	constructor(maxSize = CONFIG.browser.maxConcurrent) {
		this.maxSize = maxSize
		this.browsers = []
		this.queue = []
		this.activeBrowsers = 0
	}

	async getBrowser() {
		return new Promise(async (resolve, reject) => {
			try {
				if (this.browsers.length > 0) {
					const browser = this.browsers.pop()
					resolve(browser)
				} else if (this.activeBrowsers < this.maxSize) {
					this.activeBrowsers++
					const browser = await puppeteer.launch({
						headless: CONFIG.browser.headless,
						args: [
							'--no-sandbox',
							'--disable-setuid-sandbox',
							'--disable-dev-shm-usage',
							'--disable-gpu',
							'--disable-web-security',
							'--disable-features=VizDisplayCompositor',
						],
					})
					resolve(browser)
				} else {
					this.queue.push({ resolve, reject })
				}
			} catch (error) {
				this.activeBrowsers--
				reject(error)
			}
		})
	}

	async releaseBrowser(browser) {
		try {
			// Close all pages except the first one to clean up
			const pages = await browser.pages()
			for (let i = 1; i < pages.length; i++) {
				await pages[i].close()
			}

			if (this.queue.length > 0) {
				const { resolve } = this.queue.shift()
				resolve(browser)
			} else if (this.browsers.length < this.maxSize) {
				this.browsers.push(browser)
			} else {
				await browser.close()
				this.activeBrowsers--
			}
		} catch (error) {
			await browser.close()
			this.activeBrowsers--
			console.error('Error releasing browser:', error)
		}
	}

	async cleanup() {
		// Close all browsers
		for (const browser of this.browsers) {
			try {
				await browser.close()
			} catch (error) {
				console.error('Error closing browser during cleanup:', error)
			}
		}
		this.browsers = []
		this.activeBrowsers = 0
	}
}

const browserPool = new BrowserPool()

// Middleware
app.use(helmet())
app.use(compression())
app.use(cors())
app.use(express.json())

// Rate limiting
const limiter = rateLimit({
	windowMs: CONFIG.rateLimit.windowMs,
	max: CONFIG.rateLimit.max,
	message: { error: 'Too many requests, please try again later.' },
	standardHeaders: true,
	legacyHeaders: false,
})
app.use(limiter)

// Input validation middleware
const validateTicker = (req, res, next) => {
	const ticker = req.params.ticker

	if (!ticker || typeof ticker !== 'string') {
		return res.status(400).json({ error: 'Ticker symbol is required' })
	}

	// Basic ticker validation (alphanumeric, 1-5 characters typically)
	if (!/^[A-Za-z0-9.-]{1,10}$/.test(ticker)) {
		return res.status(400).json({ error: 'Invalid ticker symbol format' })
	}

	next()
}

// Enhanced scraping function
async function scrapeDividendData(ticker) {
	const url = `https://stockevents.app/en/stock/${ticker}/dividends`
	let browser = null
	let page = null

	try {
		browser = await browserPool.getBrowser()
		page = await browser.newPage()

		// Set user agent and viewport
		await page.setUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
		)
		await page.setViewport({ width: 1920, height: 1080 })

		// Set timeout
		page.setDefaultTimeout(CONFIG.browser.timeout)

		// Navigate with retry logic
		let retryCount = 0
		const maxRetries = 3

		while (retryCount < maxRetries) {
			try {
				await page.goto(url, {
					waitUntil: 'networkidle2',
					timeout: CONFIG.browser.timeout,
				})
				break
			} catch (error) {
				retryCount++
				if (retryCount === maxRetries) throw error
				await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount))
			}
		}

		// Wait for table to load with multiple selectors
		await Promise.race([
			page.waitForSelector("div[data-testid='stock-dividends-table'] table tbody tr", { timeout: 20000 }),
			page.waitForSelector('table tbody tr', { timeout: 20000 }), // Fallback selector
			new Promise((_, reject) => setTimeout(() => reject(new Error('Table load timeout')), 25000)),
		])

		// Enhanced data extraction
		const data = await page.evaluate(() => {
			// Try multiple selectors for robustness
			const selectors = [
				"div[data-testid='stock-dividends-table'] table tbody tr",
				'table tbody tr',
				'.dividend-table tbody tr',
			]

			let row = null
			for (const selector of selectors) {
				row = document.querySelector(selector)
				if (row) break
			}

			if (!row) return null

			const tds = row.querySelectorAll('td')
			if (tds.length < 4) return null

			// Extract and clean data
			const extractText = (element) => {
				return element?.innerText?.trim() || element?.textContent?.trim() || ''
			}

			return {
				exDate: extractText(tds[0]),
				payDate: extractText(tds[1]),
				dividend: extractText(tds[2]),
				yield: extractText(tds[3]),
				scrapedAt: new Date().toISOString(),
			}
		})

		return data
	} finally {
		if (browser) {
			await browserPool.releaseBrowser(browser)
		}
	}
}

// Health check endpoint
app.get('/health', (req, res) => {
	res.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		cache: {
			keys: cache.keys().length,
			stats: cache.getStats(),
		},
	})
})

// Main dividend endpoint
app.get('/dividend/:ticker', validateTicker, async (req, res) => {
	const ticker = req.params.ticker.toUpperCase()
	const cacheKey = `dividend:${ticker}`

	try {
		// Check cache first
		const cachedData = cache.get(cacheKey)
		if (cachedData) {
			return res.json({
				...cachedData,
				cached: true,
				cacheAge: Math.floor((Date.now() - new Date(cachedData.scrapedAt)) / 1000),
			})
		}

		// Scrape fresh data
		const data = await scrapeDividendData(ticker)

		if (data && data.exDate) {
			// Validate data quality
			if (!data.exDate || data.exDate === 'N/A' || data.exDate === '') {
				throw new Error('No valid dividend data found')
			}

			const response = { ticker, ...data, cached: false }

			// Cache the result
			cache.set(cacheKey, response)

			res.json(response)
		} else {
			res.status(404).json({
				error: 'No dividend data found',
				ticker,
				message: 'The ticker may not exist or may not pay dividends',
			})
		}
	} catch (error) {
		console.error(`Error scraping ${ticker}:`, error.message)

		// Return different errors based on the error type
		if (error.message.includes('timeout')) {
			res.status(408).json({
				error: 'Request timeout',
				ticker,
				message: 'The request took too long to complete',
			})
		} else if (error.message.includes('Navigation failed')) {
			res.status(503).json({
				error: 'Service unavailable',
				ticker,
				message: 'Unable to reach the data source',
			})
		} else {
			res.status(500).json({
				error: 'Scraping failed',
				ticker,
				message: 'An internal error occurred while fetching data',
			})
		}
	}
})

// Batch endpoint for multiple tickers
app.post('/dividends/batch', async (req, res) => {
	const { tickers } = req.body

	if (!Array.isArray(tickers) || tickers.length === 0) {
		return res.status(400).json({ error: 'Tickers array is required' })
	}

	if (tickers.length > 10) {
		return res.status(400).json({ error: 'Maximum 10 tickers allowed per batch request' })
	}

	const results = {}
	const promises = tickers.map(async (ticker) => {
		try {
			const upperTicker = ticker.toUpperCase()
			const cacheKey = `dividend:${upperTicker}`

			let data = cache.get(cacheKey)
			if (!data) {
				data = await scrapeDividendData(upperTicker)
				if (data) {
					const response = { ticker: upperTicker, ...data }
					cache.set(cacheKey, response)
					data = response
				}
			}

			results[upperTicker] = data || { error: 'No data found' }
		} catch (error) {
			results[ticker.toUpperCase()] = { error: error.message }
		}
	})

	await Promise.allSettled(promises)
	res.json({ results })
})

// Cache management endpoints
app.delete('/cache/:ticker?', (req, res) => {
	const ticker = req.params.ticker

	if (ticker) {
		const cacheKey = `dividend:${ticker.toUpperCase()}`
		const deleted = cache.del(cacheKey)
		res.json({ message: `Cache cleared for ${ticker}`, deleted: deleted > 0 })
	} else {
		cache.flushAll()
		res.json({ message: 'All cache cleared' })
	}
})

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('Received SIGINT, shutting down gracefully...')
	await browserPool.cleanup()
	process.exit(0)
})

process.on('SIGTERM', async () => {
	console.log('Received SIGTERM, shutting down gracefully...')
	await browserPool.cleanup()
	process.exit(0)
})

// Error handling middleware
app.use((err, req, res, next) => {
	console.error(err.stack)
	res.status(500).json({ error: 'Something went wrong!' })
})

// 404 handler
app.use((req, res) => {
	res.status(404).json({ error: 'Endpoint not found' })
})

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`)
	console.log(`Cache TTL: ${CONFIG.cache.ttl} seconds`)
	console.log(`Max concurrent browsers: ${CONFIG.browser.maxConcurrent}`)
})

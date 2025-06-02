const express = require('express')
const puppeteer = require('puppeteer')

const app = express()
const PORT = process.env.PORT || 3000

app.get('/dividend/:ticker', async (req, res) => {
	const ticker = req.params.ticker.toUpperCase()
	const url = `https://stockevents.app/en/stock/${ticker}/dividends`

	try {
		const browser = await puppeteer.launch({ headless: true })
		const page = await browser.newPage()
		await page.goto(url, { waitUntil: 'networkidle2' })

		const data = await page.evaluate(() => {
			const row = document.querySelector("div[data-testid='stock-dividends-table'] table tbody tr")
			if (!row) return null

			const tds = row.querySelectorAll('td')
			return {
				exDate: tds[0]?.innerText,
				payDate: tds[1]?.innerText,
				dividend: tds[2]?.innerText,
				yield: tds[3]?.innerText,
			}
		})

		await browser.close()

		if (data) {
			res.json({ ticker, ...data })
		} else {
			res.status(404).json({ error: 'No data found' })
		}
	} catch (err) {
		res.status(500).json({ error: 'Scraping failed', details: err.message })
	}
})

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`)
})

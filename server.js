const express = require('express')
const axios = require('axios')
const cheerio = require('cheerio')

const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => {
	res.send('Dividend API is up and running without Puppeteer.')
})

app.get('/dividend/:ticker', async (req, res) => {
	const ticker = req.params.ticker.toUpperCase()
	const url = `https://stockevents.app/en/stock/${ticker}/dividends`

	try {
		const response = await axios.get(url)
		const $ = cheerio.load(response.data)

		const row = $("div[data-testid='stock-dividends-table'] table tbody tr").first()
		if (!row || row.length === 0) {
			return res.status(404).json({ error: 'No dividend data found for this ticker.' })
		}

		const tds = row.find('td')

		const data = {
			ticker,
			exDate: $(tds[0]).text().trim(),
			payDate: $(tds[1]).text().trim(),
			dividend: $(tds[2]).text().trim(),
			yield: $(tds[3]).text().trim(),
		}

		res.json(data)
	} catch (err) {
		console.error(`Scraping error for ${ticker}:`, err.message)
		res.status(500).json({ error: 'Scraping failed', details: err.message })
	}
})

app.use((req, res) => {
	res.status(404).json({ error: 'Endpoint not found' })
})

app.listen(PORT, () => {
	console.log(`✅ Server is running on port ${PORT}`)
})

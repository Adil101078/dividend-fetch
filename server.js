const express = require('express')
const axios = require('axios')
const cheerio = require('cheerio')

const app = express()
const PORT = process.env.PORT || 3000

app.get('/dividend/:ticker', async (req, res) => {
	const ticker = req.params.ticker.toUpperCase()
	const url = `https://stockevents.app/en/stock/${ticker}/dividends`

	try {
		const response = await axios.get(url)
		const $ = cheerio.load(response.data)

		const result = {}
		const container = $('div.grid.grid-cols-2') // the parent div

		container.find('div').each((_, element) => {
			const label = $(element).find('dt').text().trim()
			const value = $(element).find('dd').text().trim()

			if (label && value) {
				if (label.toLowerCase().includes('yield')) result.yield = value
				else if (label.toLowerCase().includes('amount')) result.dividend = value
				else if (label.toLowerCase().includes('ex-date')) result.exDate = value
				else if (label.toLowerCase().includes('pay date')) result.payDate = value
			}
		})

		if (Object.keys(result).length === 0) {
			return res.status(404).json({ error: 'No data found' })
		}

		res.json({ ticker, ...result })
	} catch (err) {
		console.error(err.message)
		res.status(500).json({ error: 'Scraping failed', details: err.message })
	}
})

app.listen(PORT, () => {
	console.log(`✅ Server running on port ${PORT}`)
})

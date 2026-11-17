# Dubai Taxi or Drive

Works out whether a trip in Dubai is cheaper by taxi (electric by default) or by driving your own car.

**[Try it → dubai-taxi-or-drive.onrender.com](https://dubai-taxi-or-drive.onrender.com)** · [![Smoke test](https://github.com/Hammerzzzzz/dubai-taxi-or-drive/actions/workflows/smoke-test.yml/badge.svg)](https://github.com/Hammerzzzzz/dubai-taxi-or-drive/actions/workflows/smoke-test.yml)

## Why I built it

"Should I just get a taxi?" is a question people in Dubai ask almost every day. The answer depends on Salik tolls, peak fares, parking and fuel, and nobody works that out properly. I wanted a quick, honest answer for a real trip at a real time of day.

- **Audience:** Dubai residents and visitors deciding how to get somewhere.
- **Approach:** live Google routes and traffic, Salik gates detected along the actual route, the current RTA tariff, and UAE fuel prices. Every assumption can be edited on the page, so the answer is transparent rather than a black box.
- **What I'd measure:** trips calculated, how often taxi wins versus car, and which assumptions people change most.
- **What I learned:** a useful tool lives or dies on the edge cases: night fares, airport starts, free Salik hours and minimum fares. It also needs to cost almost nothing to run, so results are cached and lookups are rate-limited.

- **Route:** exact start and finish points with address search. Distance and traffic-aware drive time come from the Google Maps Routes API for your departure time.
- **Salik:** gates are found by checking the Google route line against each gate's position. They are priced with the variable rates (AED 6.30 peak, 4.20 off-peak, free 1–6am). Al Maktoum Bridge is free on Sundays and from 10pm to 6am.
- **Taxi:** RTA tariff, day and night starting fares, peak app surcharge, airport starting fare, waiting time and minimum fare. You can pick from five taxi types.
- **Car:** fuel or charging cost at UAE monthly prices, extra fuel use in heavy traffic, parking, and optional wear and depreciation.

Every rate can be edited in the page under **Rates & assumptions**.

## Run locally

```bash
GOOGLE_MAPS_API_KEY=your-key npm start
```

Then open http://localhost:3000. Without a key, the page falls back to straight-line distance estimates.

The app has no dependencies and needs Node 20 or newer.

## Google Cloud setup

1. In a Google Cloud project with billing turned on, enable **Routes API** and **Places API (New)**.
2. Create an API key and restrict it to those two APIs. The key is only used on the server, so set no website restriction.
3. Set a budget alert. The server caches results and limits each IP to 60 route lookups and 300 searches per 10 minutes.

## Deploy (Render)

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `GOOGLE_MAPS_API_KEY`

To check that the key works and see the Salik gate positions in use, open `/api/health`.

## Updating rates

Fuel prices change monthly. Update the default values in `public/index.html`: the inputs `p98`, `p95`, `p91` and `pdsl`.

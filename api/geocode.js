/**
 * /api/geocode
 * Resolves a city/location string to lat, lng, formatted address, and country
 * using the Google Maps Geocoding API.
 *
 * POST body: { query: "Paris, France" }
 * Response:  { lat, lng, loc, ctry }
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY not configured' });

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status !== 'OK' || !data.results || data.results.length === 0) {
            return res.status(404).json({ error: 'Location not found', status: data.status });
        }

        const result = data.results[0];
        const { lat, lng } = result.geometry.location;
        const loc = result.formatted_address;

        // Extract country name from address components
        const ctryComponent = result.address_components.find(c => c.types.includes('country'));
        const ctry = ctryComponent ? ctryComponent.long_name : '';

        return res.status(200).json({ lat, lng, loc, ctry });
    } catch (err) {
        return res.status(500).json({ error: 'Geocoding failed', detail: err.message });
    }
}

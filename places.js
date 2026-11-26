/* ترويقة — خرائط جوجل (Google Maps / Places)
   Used by admins only, when adding a restaurant or setting the delivery point:
     search(text, near)   → restaurants matching a name, closest to the delivery point first
     nearby(center, km)   → restaurants around the delivery point (Nearby Search)
     phone(id)            → the phone number of the place that was picked
   Only these fields are asked for, to stay inside Google's free monthly usage:
     id, displayName, formattedAddress, location, googleMapsURI, businessStatus (+ phone for the one picked).
   The key lives in config.js (googleMapsKey). Restrict it in Google Cloud to your site address and to
   "Maps JavaScript API" + "Places API (New)", and set a daily quota, so it can't be misused or bill you. */
(function () {
  'use strict';
  const CFG = window.TARWEEQA_CONFIG || {};
  const FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'googleMapsURI', 'businessStatus'];
  const FOOD = ['restaurant', 'fast_food_restaurant', 'cafe', 'bakery', 'sandwich_shop', 'breakfast_restaurant'];
  let loading = null;
  const P = { authFailed: false };

  P.available = () => !!(CFG.googleMapsKey && String(CFG.googleMapsKey).trim()) && !P.authFailed;

  function load(lang) {
    if (window.google && google.maps && google.maps.importLibrary) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      window.__tqMapsReady = () => resolve();
      window.gm_authFailure = () => { P.authFailed = true; if (P.onAuthFail) P.onAuthFail(); };   // wrong key / API not enabled / site not allowed
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(String(CFG.googleMapsKey).trim()) +
        '&v=weekly&loading=async&language=' + (lang === 'en' ? 'en' : 'ar') + '&region=EG&callback=__tqMapsReady';
      s.async = true;
      s.onerror = () => { loading = null; reject(new Error('maps')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  async function lib(lang) {
    if (!P.available()) throw new Error('maps-off');
    await load(lang);
    return google.maps.importLibrary('places');
  }
  function plain(p) {
    const loc = p.location;
    return {
      id: p.id, name: p.displayName || '', address: p.formattedAddress || '',
      lat: loc ? (typeof loc.lat === 'function' ? loc.lat() : loc.lat) : null,
      lng: loc ? (typeof loc.lng === 'function' ? loc.lng() : loc.lng) : null,
      mapsUrl: p.googleMapsURI || '', status: p.businessStatus || ''
    };
  }

  P.search = async (text, near, lang) => {
    const { Place } = await lib(lang);
    const req = { textQuery: text, fields: FIELDS, maxResultCount: 10, language: lang === 'en' ? 'en' : 'ar', region: 'eg' };
    if (near && isFinite(near.lat)) req.locationBias = { center: { lat: near.lat, lng: near.lng }, radius: 5000 };
    const { places } = await Place.searchByText(req);
    return (places || []).map(plain).filter(p => p.lat != null);
  };

  P.nearby = async (center, km, lang) => {
    const { Place, SearchNearbyRankPreference } = await lib(lang);
    const { places } = await Place.searchNearby({
      fields: FIELDS, includedTypes: FOOD, maxResultCount: 20,
      locationRestriction: { center: { lat: center.lat, lng: center.lng }, radius: Math.min(50000, Math.max(300, (km || 3) * 1000)) },
      rankPreference: SearchNearbyRankPreference ? SearchNearbyRankPreference.DISTANCE : 'DISTANCE',
      language: lang === 'en' ? 'en' : 'ar', region: 'eg'
    });
    return (places || []).map(plain).filter(p => p.lat != null);
  };

  P.phone = async (id, lang) => {
    try {
      const { Place } = await lib(lang);
      const p = new Place({ id });
      await p.fetchFields({ fields: ['nationalPhoneNumber'] });
      return (p.nationalPhoneNumber || '').replace(/\s+/g, '');
    } catch (e) { console.warn(e); return ''; }
  };

  // the phone's own location (free, no Google call): used to set the delivery point
  P.here = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('geo'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      err => reject(err), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  window.TarweeqaPlaces = P;
})();

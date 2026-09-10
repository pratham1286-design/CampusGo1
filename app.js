const destination = document.querySelector('#destination');
const clearSearch = document.querySelector('#clear-search');
const serviceCards = [...document.querySelectorAll('.service-card')];
const fareValue = document.querySelector('#fare-value');
const fareCopy = document.querySelector('#fare-copy');
const rideModal = document.querySelector('#ride-modal');
const activeRide = document.querySelector('#active-ride');
const toast = document.querySelector('#toast');
let selectedService = serviceCards[0];
const onboardingModal = document.querySelector('#onboarding-modal');
const identityModal = document.querySelector('#identity-modal');
const profileDetailsModal = document.querySelector('#profile-details-modal');
const driverDashboard = document.querySelector('#driver-dashboard');
let selectedRole = 'Rider';
const API_BASE = 'http://localhost:8000';
let pendingRideId = null;
let sessionPromise = null;
let profileDetailMode = 'contact';
const CAMPUS_PICKUP = { lat: 31.2546, lng: 75.7033, label: 'Near Block 14' };
let selectedPlace = null;
let campusMap = null;
let activeMap = null;
let pickupMarker = null;
let destinationMarker = null;
let routeLayer = null;
let searchTimer = null;

function makeMapIcon(kind) {
  return L.divIcon({ className: 'map-marker-wrap', html: `<span class="map-marker ${kind}">${kind === 'pickup' ? '●' : '⌖'}</span>`, iconSize: [32, 32], iconAnchor: [16, 16] });
}

function initialiseMap() {
  if (!window.L) { showToast('Map service is unavailable. You can still book with a typed destination.'); return; }
  campusMap = L.map('campus-map', { zoomControl: false, attributionControl: true }).setView([CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(campusMap);
  pickupMarker = L.marker([CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], { icon: makeMapIcon('pickup') }).addTo(campusMap).bindTooltip('Pickup: Near Block 14');
  document.querySelector('#zoom-in').addEventListener('click', () => campusMap?.zoomIn());
  document.querySelector('#zoom-out').addEventListener('click', () => campusMap?.zoomOut());
  document.querySelector('#locate-me').addEventListener('click', requestDeviceLocation);
}

function requestDeviceLocation() {
  if (!navigator.geolocation) return showToast('Location is not supported in this browser');
  showToast('Requesting your location…');
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    CAMPUS_PICKUP.lat = coords.latitude; CAMPUS_PICKUP.lng = coords.longitude;
    pickupMarker?.setLatLng([coords.latitude, coords.longitude]).bindTooltip('Your location').openTooltip();
    campusMap?.setView([coords.latitude, coords.longitude], 16);
    document.querySelector('#map-location-title').textContent = 'Your location';
    document.querySelector('#map-location-copy').textContent = 'Live pickup enabled';
    updateRoute(); showToast('Live pickup location enabled');
  }, () => showToast('Location was not shared. Using Near Block 14 instead.'), { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

async function searchDestinations(query) {
  const results = document.querySelector('#destination-results');
  if (query.trim().length < 3) return closeDestinationResults();
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(`${query}, Punjab`)}`);
    if (!response.ok) throw new Error('search unavailable');
    const places = await response.json();
    results.innerHTML = places.length ? places.map((place, index) => `<button class="destination-result" role="option" data-index="${index}"><span>⌖</span><span>${place.display_name}</span></button>`).join('') : '<p class="destination-empty">No exact result. You can still use this destination.</p>';
    results.classList.remove('hidden'); destination.setAttribute('aria-expanded', 'true');
    results.querySelectorAll('.destination-result').forEach(button => button.addEventListener('click', () => selectDestination(places[Number(button.dataset.index)])));
  } catch { results.innerHTML = '<p class="destination-empty">Search is offline. You can still use this destination.</p>'; results.classList.remove('hidden'); }
}

function closeDestinationResults() { document.querySelector('#destination-results').classList.add('hidden'); destination.setAttribute('aria-expanded', 'false'); }
function selectDestination(place) { selectedPlace = { lat: Number(place.lat), lng: Number(place.lon), label: place.display_name }; destination.value = place.display_name.split(',').slice(0, 2).join(','); clearSearch.style.display = 'block'; closeDestinationResults(); showDestinationOnMap(); }
function setCampusDestination(label) { const shortcuts = { 'Uni Mall': [31.2525, 75.7055], 'Main Gate': [31.2512, 75.6967] }; const [lat, lng] = shortcuts[label] || [31.2546, 75.7033]; selectedPlace = { lat, lng, label }; destination.value = label; clearSearch.style.display = 'block'; closeDestinationResults(); showDestinationOnMap(); }
function showDestinationOnMap() { if (!campusMap || !selectedPlace) return; destinationMarker?.remove(); destinationMarker = L.marker([selectedPlace.lat, selectedPlace.lng], { icon: makeMapIcon('destination') }).addTo(campusMap).bindTooltip(selectedPlace.label, { direction: 'top' }).openTooltip(); campusMap.fitBounds([[CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], [selectedPlace.lat, selectedPlace.lng]], { padding: [38, 38], maxZoom: 16 }); updateRoute(); }
async function updateRoute() { if (!campusMap || !selectedPlace) return; routeLayer?.remove(); const start = `${CAMPUS_PICKUP.lng},${CAMPUS_PICKUP.lat}`; const end = `${selectedPlace.lng},${selectedPlace.lat}`; try { const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson`); const route = await response.json(); if (route.code !== 'Ok') throw new Error('route unavailable'); routeLayer = L.geoJSON(route.routes[0].geometry, { style: { color: '#ff7c00', weight: 5, opacity: 0.88 } }).addTo(campusMap); } catch { routeLayer = L.polyline([[CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], [selectedPlace.lat, selectedPlace.lng]], { color: '#ff7c00', weight: 4, dashArray: '8 8', opacity: 0.8 }).addTo(campusMap); } }

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : body.detail?.reason || 'CampusGo request failed');
  return body;
}

function ensureSession() {
  if (!sessionPromise) {
    identityModal.classList.remove('hidden');
    showToast('Verify your LPU identity first');
    throw new Error('identity_required');
  }
  return sessionPromise;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2400);
}

function selectService(card) {
  serviceCards.forEach(item => item.classList.remove('selected'));
  card.classList.add('selected');
  selectedService = card;
  fareValue.textContent = `₹${card.dataset.fare}`;
  fareCopy.textContent = `${card.dataset.service} · ${card.dataset.service === 'Bike' ? '3' : card.dataset.service === 'Scooty' ? '4' : '5'} min away`;
}

serviceCards.forEach(card => card.addEventListener('click', () => selectService(card)));
destination.addEventListener('input', () => { clearSearch.style.display = destination.value ? 'block' : 'none'; selectedPlace = null; window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => searchDestinations(destination.value), 350); });
destination.addEventListener('keydown', event => { if (event.key === 'Escape') closeDestinationResults(); });
clearSearch.addEventListener('click', () => { destination.value = ''; selectedPlace = null; destinationMarker?.remove(); routeLayer?.remove(); clearSearch.style.display = 'none'; closeDestinationResults(); destination.focus(); });
document.querySelectorAll('.recent-place').forEach(button => button.addEventListener('click', () => setCampusDestination(button.dataset.place)));

document.querySelector('#find-ride').addEventListener('click', async () => {
  if (!destination.value.trim()) {
    destination.focus();
    showToast('Choose a destination to find a ride');
    return;
  }
  const confirmButton = document.querySelector('#confirm-ride');
  confirmButton.disabled = true;
  confirmButton.textContent = 'Checking availability...';
  document.querySelector('#ride-status').textContent = 'Checking nearby drivers in your campus zone...';
  rideModal.classList.remove('hidden');
  try {
    await ensureSession();
    const estimate = await api('/rides/estimate', { method: 'POST', body: JSON.stringify({ destination: destination.value, pickup: 'Near Block 14', service: selectedService.dataset.service }) });
    if (!estimate.available) throw new Error('No nearby driver is available for this service');
    const request = await api('/rides/request', { method: 'POST', body: JSON.stringify({ destination: destination.value, pickup: 'Near Block 14', service: selectedService.dataset.service, estimate_id: estimate.estimate_id }) });
    pendingRideId = request.ride_id;
    document.querySelector('#modal-destination').textContent = destination.value;
    document.querySelector('#modal-service').textContent = `${estimate.service} · ₹${estimate.fare} estimated`;
    document.querySelector('#ride-status').textContent = 'Driver found. Confirm to check wallet balance and lock the ride.';
    confirmButton.disabled = false;
    confirmButton.textContent = 'Confirm & start ride';
  } catch (error) {
    rideModal.classList.add('hidden');
    showToast(error.message);
  }
});

document.querySelector('#close-modal').addEventListener('click', () => rideModal.classList.add('hidden'));
document.querySelector('#confirm-ride').addEventListener('click', async () => {
  const confirmButton = document.querySelector('#confirm-ride');
  confirmButton.disabled = true;
  confirmButton.textContent = 'Confirming securely...';
  try {
    await api(`/rides/${pendingRideId}/confirm`, { method: 'POST' });
    rideModal.classList.add('hidden');
    activeRide.classList.remove('hidden');
    document.querySelector('#active-destination-label').textContent = destination.value;
    initialiseActiveMap();
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'Confirm & start ride';
    showToast(error.message === 'topup_needed' ? 'Your wallet needs a top-up before this ride' : error.message);
  }
});

function initialiseActiveMap() {
  if (!window.L || activeMap) return;
  activeMap = L.map('active-map', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false }).setView([CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(activeMap);
  L.marker([CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], { icon: makeMapIcon('pickup') }).addTo(activeMap);
  if (selectedPlace) { L.marker([selectedPlace.lat, selectedPlace.lng], { icon: makeMapIcon('destination') }).addTo(activeMap); L.polyline([[CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], [selectedPlace.lat, selectedPlace.lng]], { color: '#ff7c00', weight: 5 }).addTo(activeMap); activeMap.fitBounds([[CAMPUS_PICKUP.lat, CAMPUS_PICKUP.lng], [selectedPlace.lat, selectedPlace.lng]], { padding: [45, 45] }); }
}
document.querySelector('#sos-button').addEventListener('click', async () => { try { await ensureSession(); await api(`/rides/${pendingRideId}/sos`, { method: 'POST' }); showToast('SOS alert queued for trusted contacts'); } catch (error) { showToast(error.message); } });
document.querySelector('#share-location').addEventListener('click', event => { event.currentTarget.textContent = '✓ Location shared with contacts'; showToast('Live location sharing is active'); });
document.querySelector('#close-modal').addEventListener('keydown', event => { if (event.key === 'Escape') rideModal.classList.add('hidden'); });

function openOnboarding() { if (!sessionPromise) { identityModal.classList.remove('hidden'); return; } onboardingModal.classList.remove('hidden'); }
const servicesView = document.querySelector('#services-view');
const activityView = document.querySelector('#activity-view');
function closeTabViews() { servicesView.classList.add('hidden'); activityView.classList.add('hidden'); }
function showRideView() { closeTabViews(); onboardingModal.classList.add('hidden'); profileDetailsModal.classList.add('hidden'); document.querySelector('.tab.active')?.classList.remove('active'); document.querySelector('.tab').classList.add('active'); }
function showServicesView() { closeTabViews(); onboardingModal.classList.add('hidden'); identityModal.classList.add('hidden'); servicesView.classList.remove('hidden'); }
async function showActivityView() {
  closeTabViews();
  onboardingModal.classList.add('hidden');
  identityModal.classList.add('hidden');
  activityView.classList.remove('hidden');
  const list = document.querySelector('#activity-list');
  list.innerHTML = '<div class="activity-loading">Loading your rides...</div>';
  try {
    await ensureSession();
    const rides = await api('/rides/history');
    list.innerHTML = rides.length ? rides.map(ride => `<div class="activity-item"><span class="activity-icon">${ride.service === 'Car' ? '▱' : ride.service === 'Scooty' ? '◒' : '♢'}</span><div><strong>${ride.destination}</strong><small>${ride.service} · ${ride.status.replace('_', ' ')} · ₹${ride.fare}</small></div><time>${new Date(ride.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</time></div>`).join('') : '<div class="activity-empty"><strong>No rides yet</strong><small>Your booked rides will appear here.</small></div>';
  } catch (error) { list.innerHTML = `<div class="activity-empty"><strong>Sign in to view activity</strong><small>${error.message}</small></div>`; }
}
document.querySelector('#profile-button').addEventListener('click', openOnboarding);
document.querySelector('#profile-tab').addEventListener('click', openOnboarding);
document.querySelector('#close-identity').addEventListener('click', () => identityModal.classList.add('hidden'));
document.querySelector('#verify-identity').addEventListener('click', async () => {
  const lpuId = document.querySelector('#lpu-id').value.trim();
  const email = document.querySelector('#lpu-email').value.trim();
  const status = document.querySelector('#identity-status');
  try {
    const challenge = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ lpu_id: lpuId, email }) });
    sessionPromise = api('/auth/login', { method: 'POST', body: JSON.stringify({ challenge_id: challenge.challenge_id }) });
    await sessionPromise;
    identityModal.classList.add('hidden');
    if (activityView.classList.contains('hidden')) {
      onboardingModal.classList.remove('hidden');
      document.querySelector('#onboarding-modal .setup-step.active small').textContent = `Verified · ${lpuId}`;
    } else {
      await showActivityView();
    }
    status.textContent = 'Verified';
  } catch (error) { sessionPromise = null; status.textContent = error.message; }
});
document.querySelector('#close-onboarding').addEventListener('click', () => onboardingModal.classList.add('hidden'));
document.querySelector('#close-profile-details').addEventListener('click', () => profileDetailsModal.classList.add('hidden'));
document.querySelector('#location-button').addEventListener('click', event => { event.currentTarget.textContent = 'Enabled'; event.currentTarget.classList.add('done'); showToast('Nearest pickup point detected'); });
document.querySelector('#role-button').addEventListener('click', () => document.querySelector('#role-options').classList.toggle('hidden'));
document.querySelectorAll('.role-choice').forEach(choice => choice.addEventListener('click', async () => {
  document.querySelectorAll('.role-choice').forEach(item => item.classList.remove('selected'));
  choice.classList.add('selected');
  selectedRole = choice.dataset.role;
  document.querySelector('#role-copy').textContent = `${choice.dataset.role} selected`;
  document.querySelector('#role-options').classList.add('hidden');
  document.querySelector('#vehicle-step').classList.toggle('hidden', choice.dataset.role === 'Rider');
  try { await ensureSession(); await api('/profile/role', { method: 'POST', body: JSON.stringify({ role: choice.dataset.role.toLowerCase(), teacher: false }) }); } catch (error) { showToast(error.message); }
}));
function openProfileDetails(mode) {
  profileDetailMode = mode;
  profileDetailsModal.classList.remove('hidden');
  const vehicleFields = ['vehicle-type', 'vehicle-plate', 'vehicle-model'];
  const isVehicle = mode === 'vehicle';
  document.querySelector('#profile-details-title').textContent = isVehicle ? 'Add vehicle details' : 'Add trusted contact';
  document.querySelector('#profile-details-copy').textContent = isVehicle ? 'Vehicle details are required before accepting rides.' : 'This contact can receive SOS alerts during a ride.';
  vehicleFields.forEach(id => { document.querySelector(`#${id}`).style.display = isVehicle ? 'block' : 'none'; });
  document.querySelector('#contact-name').style.display = isVehicle ? 'none' : 'block';
  document.querySelector('#contact-phone').style.display = isVehicle ? 'none' : 'block';
}
document.querySelector('#contact-button').addEventListener('click', () => openProfileDetails('contact'));
document.querySelector('#vehicle-button').addEventListener('click', () => openProfileDetails('vehicle'));
document.querySelector('#save-profile-detail').addEventListener('click', async () => {
  const status = document.querySelector('#profile-details-status');
  try {
    await ensureSession();
    if (profileDetailMode === 'contact') {
      await api('/profile/emergency-contacts', { method: 'POST', body: JSON.stringify({ name: document.querySelector('#contact-name').value.trim(), phone: document.querySelector('#contact-phone').value.trim() }) });
      document.querySelector('#contact-button').textContent = 'Added';
      document.querySelector('#contact-button').classList.add('done');
      document.querySelector('#contact-copy').textContent = `${document.querySelector('#contact-name').value.trim()} · saved`;
    } else {
      await api('/profile/vehicle', { method: 'POST', body: JSON.stringify({ type: document.querySelector('#vehicle-type').value, plate: document.querySelector('#vehicle-plate').value.trim(), model: document.querySelector('#vehicle-model').value.trim() }) });
      document.querySelector('#vehicle-button').textContent = 'Added';
      document.querySelector('#vehicle-button').classList.add('done');
      document.querySelector('#vehicle-button').previousElementSibling.querySelector('small').textContent = `${document.querySelector('#vehicle-model').value.trim()} · ${document.querySelector('#vehicle-plate').value.trim()}`;
    }
    profileDetailsModal.classList.add('hidden');
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#complete-onboarding').addEventListener('click', () => { onboardingModal.classList.add('hidden'); if (selectedRole !== 'Rider') driverDashboard.classList.remove('hidden'); else showToast('CampusGo profile saved'); });
document.querySelector('#close-driver').addEventListener('click', () => driverDashboard.classList.add('hidden'));
document.querySelector('#driver-online').addEventListener('click', event => { event.currentTarget.textContent = '✓ You are online'; showToast('You can now receive nearby ride requests'); });
document.querySelector('#post-route').addEventListener('click', () => showToast('Route form is ready for your next city trip'));
document.querySelectorAll('.view-close').forEach(button => button.addEventListener('click', showRideView));
document.querySelector('#services-ride-button').addEventListener('click', () => { showRideView(); destination.focus(); });
document.querySelector('#activity-ride-button').addEventListener('click', () => { showRideView(); destination.focus(); });
document.querySelectorAll('[data-view-service]').forEach(card => card.addEventListener('click', () => { showRideView(); const service = card.dataset.viewService === 'Car' ? 'Car' : 'Bike'; selectService(serviceCards.find(item => item.dataset.service === service)); destination.focus(); }));

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
  tab.classList.add('active');
  const label = tab.querySelector('small').textContent;
  if (label === 'Profile') openOnboarding();
  if (label === 'Services') showServicesView();
  if (label === 'Activity') showActivityView();
  if (label === 'Ride') closeTabViews();
}));

initialiseMap();

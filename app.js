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
destination.addEventListener('input', () => { clearSearch.style.display = destination.value ? 'block' : 'none'; });
clearSearch.addEventListener('click', () => { destination.value = ''; clearSearch.style.display = 'none'; destination.focus(); });
document.querySelectorAll('.recent-place').forEach(button => button.addEventListener('click', () => { destination.value = button.dataset.place; clearSearch.style.display = 'block'; }));

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
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'Confirm & start ride';
    showToast(error.message === 'topup_needed' ? 'Your wallet needs a top-up before this ride' : error.message);
  }
});
document.querySelector('#sos-button').addEventListener('click', async () => { try { await ensureSession(); await api(`/rides/${pendingRideId}/sos`, { method: 'POST' }); showToast('SOS alert queued for trusted contacts'); } catch (error) { showToast(error.message); } });
document.querySelector('#share-location').addEventListener('click', event => { event.currentTarget.textContent = '✓ Location shared with contacts'; showToast('Live location sharing is active'); });
document.querySelector('#close-modal').addEventListener('keydown', event => { if (event.key === 'Escape') rideModal.classList.add('hidden'); });

function openOnboarding() { if (!sessionPromise) { identityModal.classList.remove('hidden'); return; } onboardingModal.classList.remove('hidden'); }
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
    onboardingModal.classList.remove('hidden');
    document.querySelector('#onboarding-modal .setup-step.active small').textContent = `Verified · ${lpuId}`;
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

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
  tab.classList.add('active');
  if (tab.querySelector('small').textContent === 'Profile') openOnboarding();
  if (tab.querySelector('small').textContent === 'Services') showToast('Campus Hop and CityLink services');
}));

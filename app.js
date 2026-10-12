/**
 * LifeDrop - Blood Donation Monitor
 * Workflow follows the project flowchart:
 *   START -> Login / Register -> choose ONE role -> account details + blood group
 *   -> Firebase Authentication -> role locked for the account/session
 *   -> Patient flow | Donor flow | Doctor flow  (all data synced in Firestore)
 *
 * Pure HTML/CSS/JS. Run with VS Code Live Server or `npm run dev`.
 */

// =========================================================================
// 1. FIREBASE CONNECTION (Firestore + Authentication)
// =========================================================================
function connectFirebaseDatabase() {
  const firebaseConfig = {
    apiKey: "AIzaSyDv7Lm4da4E_g8U31W4iqtr6O9shQJ9l7w",
    authDomain: "life-drop-d8a32.firebaseapp.com",
    projectId: "life-drop-d8a32",
    storageBucket: "life-drop-d8a32.firebasestorage.app",
    messagingSenderId: "562639032756",
    appId: "1:562639032756:web:5057677c5f7137966a62e1",
    measurementId: "G-TKQQVN5DXH"
  };

  try {
    if (typeof window !== 'undefined' && window.firebase && window.firebase.initializeApp) {
      if (!window.firebase.apps.length) window.firebase.initializeApp(firebaseConfig);
      const db = window.firebase.firestore ? window.firebase.firestore() : null;
      const auth = window.firebase.auth ? window.firebase.auth() : null;
      return { isConnected: Boolean(db && auth), projectId: firebaseConfig.projectId, db, auth };
    }
  } catch (err) {
    console.error('[Firebase] Initialisation failed:', err);
  }
  return { isConnected: false, projectId: firebaseConfig.projectId, db: null, auth: null };
}

const fb = connectFirebaseDatabase();
const serverTime = () => window.firebase.firestore.FieldValue.serverTimestamp();

// =========================================================================
// 2. CONSTANTS, THEMES, HELPERS
// =========================================================================
const BLOOD_GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

// Flowchart colours: Patient = red, Donor = green, Doctor = blue
const THEME = {
  patient: { label: 'Patient', hex: '#DC2626', dark: '#7F1D1D', soft: 'bg-rose-50 border-rose-200 text-red-700',    ring: 'border-rose-200',    icon: 'user' },
  donor:   { label: 'Donor',   hex: '#16A34A', dark: '#14532D', soft: 'bg-emerald-50 border-emerald-200 text-emerald-700', ring: 'border-emerald-200', icon: 'heartHandshake' },
  doctor:  { label: 'Doctor',  hex: '#1D4ED8', dark: '#1E3A8A', soft: 'bg-blue-50 border-blue-200 text-blue-700',  ring: 'border-blue-200',    icon: 'stethoscope' },
  admin:   { label: 'Admin', hex: '#6D28D9', dark: '#3B0764', soft: 'bg-violet-50 border-violet-200 text-violet-700', ring: 'border-violet-200', icon: 'shieldCheck' }
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byNewest = (a, b) => (b.createdAt?.seconds ?? 9e12) - (a.createdAt?.seconds ?? 9e12);

// Flowchart step: "Check blood group compatibility"
function bloodGroupCanDonate(donorGroup, recipientGroup) {
  const compatibility = {
    'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
    'O+': ['O+', 'A+', 'B+', 'AB+'],
    'A-': ['A-', 'A+', 'AB-', 'AB+'],
    'A+': ['A+', 'AB+'],
    'B-': ['B-', 'B+', 'AB-', 'AB+'],
    'B+': ['B+', 'AB+'],
    'AB-': ['AB-', 'AB+'],
    'AB+': ['AB+']
  };
  return (compatibility[donorGroup] || []).includes(recipientGroup);
}

// =========================================================================
// 3. APP STATE (everything below `currentUser` is live Firestore data)
// =========================================================================
const state = {
  authReady: false,        // true once Firebase Auth has told us who (if anyone) is signed in
  authBusy: false,
  authError: '',
  authMode: 'signin',      // 'signin' | 'register'
  portalRole: 'patient',   // role chosen on the login screen
  regBlood: 'O+',

  currentUser: null,       // Firestore users/{uid} profile (role is locked once created)
  page: 'dashboard',       // 'dashboard' | 'appointments'

  requests: [],            // patient: my blood requests
  donorsAvailable: [],     // patient: donors with status Available
  openRequests: [],        // donor: open patient requests
  donorProfile: null,      // donor: my donors/{uid} record
  matches: [],             // patient/donor: my match offers
  contacts: {},            // matchId -> { patient:{...}, donor:{...} } (only readable after Accepted)
  appointments: [],        // patient/donor: mine; doctor: all
  adminDonors: [], adminMatches: [], adminRequests: [], // admin-only monitoring

  showRequestModal: false,
  showBookingModal: false,
  bookingService: 'Consultation',
  decision: null,          // doctor: { id, action: 'approve' | 'reject' }
  selectedApptId: null,
  doctorFilter: 'All',
  toast: ''
};

let unsubscribers = [];
let toastTimer = null;

function showToast(message) {
  state.toast = message;
  renderApp();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; renderApp(); }, 4000);
}

function handleFirebaseError(err) {
  const code = err && err.code ? err.code : 'unknown';
  console.error('[Firebase]', code, err);
  if (code === 'permission-denied') showToast('Blocked by Firestore Security Rules. Publish firestore.rules from the project.');
  else showToast('Firebase error: ' + code);
}

// Re-render without destroying a form the user is typing in.
function softRender() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.closest('#app')) {
    setTimeout(softRender, 800);
    return;
  }
  renderApp();
}

// =========================================================================
// 4. REALTIME SYNC (what each role is allowed to see)
// =========================================================================
function stopListeners() {
  unsubscribers.forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
  unsubscribers = [];
}

function listen(query, onData) {
  unsubscribers.push(query.onSnapshot(
    (snap) => { onData(snap.docs.map((d) => ({ ...d.data(), id: d.id }))); softRender(); },
    handleFirebaseError
  ));
}

function onMatchesChanged(list) {
  state.matches = list.sort(byNewest);
  state.matches
    .filter((m) => m.status === 'Accepted' && !state.contacts[m.id])
    .forEach(loadContacts);
}

// Contact details live in matches/{id}/contact/* and are only readable once the match is Accepted.
async function loadContacts(match) {
  state.contacts[match.id] = {};
  try {
    const snap = await fb.db.collection('matches').doc(match.id).collection('contact').get();
    const data = {};
    snap.forEach((d) => { data[d.id] = d.data(); });
    state.contacts[match.id] = data;
    renderApp();
  } catch (err) {
    delete state.contacts[match.id];
    handleFirebaseError(err);
  }
}

function startListeners(profile) {
  stopListeners();
  const db = fb.db;
  const uid = profile.uid;

  if (profile.role === 'patient') {
    listen(db.collection('patientRequests').where('patientUid', '==', uid), (r) => { state.requests = r.sort(byNewest); });
    listen(db.collection('donors').where('status', '==', 'Available'), (d) => { state.donorsAvailable = d; });
    listen(db.collection('matches').where('patientUid', '==', uid), onMatchesChanged);
  }

  if (profile.role === 'donor') {
    listen(db.collection('patientRequests').where('status', '==', 'Open'), (r) => { state.openRequests = r.sort(byNewest); });
    unsubscribers.push(db.collection('donors').doc(uid).onSnapshot(
      (doc) => { state.donorProfile = doc.exists ? { ...doc.data(), id: doc.id } : null; softRender(); },
      handleFirebaseError
    ));
    listen(db.collection('matches').where('donorUid', '==', uid), onMatchesChanged);
  }

  if (profile.role === 'admin') {
    listen(db.collection('donors'), (d) => { state.adminDonors = d.sort((a,b) => (a.name || '').localeCompare(b.name || '')); });
    listen(db.collection('matches'), (m) => { state.adminMatches = m.sort(byNewest); });
    listen(db.collection('patientRequests'), (r) => { state.adminRequests = r.sort(byNewest); });
  }

  if (profile.role === 'doctor') {
    listen(db.collection('appointments'), (a) => { state.appointments = a.sort(byNewest); });
  } else if (profile.role === 'patient' || profile.role === 'donor') {
    listen(db.collection('appointments').where('requesterUid', '==', uid), (a) => { state.appointments = a.sort(byNewest); });
  }
}

// =========================================================================
// 5. AUTHENTICATION  (Login/Register -> role -> authenticate -> role locked)
// =========================================================================
function authMessage(err) {
  const map = {
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found for that email.',
    'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
    'auth/operation-not-allowed': 'Email/Password sign-in is not enabled in Firebase Console → Authentication → Sign-in method.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'app/no-profile': 'This account has no LifeDrop profile. Register a new account.',
    'app/admin-register': 'Admin accounts cannot be registered here. Create the admin profile securely in Firebase first.',
    'app/role-locked': 'This account is registered under a different role. Choose the correct login role.'
  };
  if (err && err.code === 'app/role-locked') {
    return `This account is registered as ${THEME[err.role]?.label || err.role}. The role is locked, so choose "${THEME[err.role]?.label || err.role}" to sign in.`;
  }
  return map[err && err.code] || (err && err.message) || 'Something went wrong. Please try again.';
}

async function loadProfile(uid) {
  const snap = await fb.db.collection('users').doc(uid).get();
  if (!snap.exists) throw { code: 'app/no-profile' };
  return { ...snap.data(), uid };
}

function beginSession(profile) {
  state.currentUser = profile;
  state.page = 'dashboard';
  startListeners(profile);
}

function endSession() {
  stopListeners();
  Object.assign(state, {
    currentUser: null, page: 'dashboard', requests: [], donorsAvailable: [], openRequests: [],
    donorProfile: null, matches: [], contacts: {}, appointments: [],
    showRequestModal: false, showBookingModal: false, decision: null, selectedApptId: null
  });
}

function initAuth() {
  if (!fb.auth) { state.authReady = true; renderApp(); return; }
  // Restores the session on page reload. Sign-in/register handlers manage themselves via authBusy.
  fb.auth.onAuthStateChanged(async (user) => {
    if (state.authBusy) return;
    try {
      if (!user) { endSession(); }
      else { beginSession(await loadProfile(user.uid)); }
    } catch (err) {
      console.error(err);
      state.authError = authMessage(err);
      await fb.auth.signOut();
      endSession();
    }
    state.authReady = true;
    renderApp();
  });
}

window.setAuthMode = (mode) => {
  // Admin accounts are provisioned manually in Firebase Console; no public admin registration.
  if (state.portalRole === 'admin' && mode === 'register') mode = 'signin';
  state.authMode = mode;
  state.authError = '';
  renderApp();
};
window.setPortalRole = (role) => {
  state.portalRole = role;
  if (role === 'admin') state.authMode = 'signin';
  state.authError = '';
  renderApp();
};
window.selectRegBlood = (bg) => { state.regBlood = bg; renderApp(); };

window.submitAuth = async function (e) {
  e.preventDefault();
  if (state.authBusy || !fb.auth) return;
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const email = val('auth-email');
  const password = document.getElementById('auth-password')?.value || '';
  const role = state.portalRole;
  if (state.authMode === 'register' && role === 'admin') { state.authError = 'Admin accounts cannot be registered here. Create the admin profile securely in Firebase first.'; renderApp(); return; }

  state.authBusy = true;
  state.authError = '';
  renderApp();

  let createdUser = null;
  try {
    if (state.authMode === 'signin') {
      const cred = await fb.auth.signInWithEmailAndPassword(email, password);
      const profile = await loadProfile(cred.user.uid);
      if (profile.role !== role) {
        await fb.auth.signOut();
        throw { code: 'app/role-locked', role: profile.role };
      }
      beginSession(profile);
    } else {
      const cred = await fb.auth.createUserWithEmailAndPassword(email, password);
      createdUser = cred.user;
      const uid = cred.user.uid;
      const profile = {
        role, name: val('auth-name'), email, phone: val('auth-phone'), city: val('auth-city'),
        createdAt: serverTime()
      };
      if (role !== 'doctor') profile.bloodGroup = state.regBlood;
      if (role === 'doctor') { profile.licenseNumber = val('auth-license'); profile.hospital = val('auth-hospital'); }

      await fb.db.collection('users').doc(uid).set(profile);
      if (role === 'donor') {
        await fb.db.collection('donors').doc(uid).set({
          donorUid: uid, name: profile.name, phone: profile.phone || '', bloodGroup: state.regBlood, city: profile.city,
          availability: 'Immediate', status: 'Available', createdAt: serverTime()
        });
      }
      createdUser = null;
      beginSession({ ...profile, uid });
    }
  } catch (err) {
    console.error(err);
    state.authError = authMessage(err);
    if (createdUser) { try { await createdUser.delete(); } catch (e2) { /* ignore */ } }
    endSession();
  } finally {
    state.authBusy = false;
    state.authReady = true;
    renderApp();
  }
};

window.appLogout = async function () {
  try { if (fb.auth) await fb.auth.signOut(); } catch (e) { console.error(e); }
  endSession();
  renderApp();
};

window.appNav = (page) => { state.page = page; renderApp(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

// =========================================================================
// 6. PATIENT / DONOR MATCHING  (select -> other side accepts or rejects)
// =========================================================================
const matchIdFor = (requestId, donorUid) => `${requestId}_${donorUid}`;

function myContact() {
  const u = state.currentUser;
  return { name: u.name, phone: u.phone || '', city: u.city || '' };
}

// Initiator picks a counterpart. Patient: "Select donor / Send request". Donor: "Select patient / Accept request".
async function createOffer(request, donor, initiatedBy) {
  if (!request || !donor) return;
  const until = donor.cooldownUntil?.toDate ? donor.cooldownUntil.toDate() : (donor.cooldownUntil ? new Date(donor.cooldownUntil) : null);
  if (until && until > new Date()) { showToast(`Recent donation cooldown ends ${until.toLocaleDateString()}.`); return; }
  if (!bloodGroupCanDonate(donor.bloodGroup, request.bloodGroup)) {
    showToast(`Incompatible: ${donor.bloodGroup} donor cannot give to ${request.bloodGroup} recipient.`);
    return;
  }
  const donorUid = donor.id;
  const id = matchIdFor(request.id, donorUid);
  if (state.matches.some((m) => m.id === id)) return;

  const ref = fb.db.collection('matches').doc(id);
  const batch = fb.db.batch();
  batch.set(ref, {
    requestId: request.id, patientUid: request.patientUid, donorUid,
    patientName: request.patientName, donorName: donor.name,
    patientPhone: request.patientPhone || '', donorPhone: donor.phone || '',
    patientBloodGroup: request.bloodGroup, donorBloodGroup: donor.bloodGroup,
    units: request.units, hospital: request.hospital, urgency: request.urgency, location: request.location,
    initiatedBy, status: 'Pending', createdAt: serverTime()
  });
  batch.set(ref.collection('contact').doc(initiatedBy), {
    ...myContact(), location: initiatedBy === 'patient' ? `${request.hospital}, ${request.location}` : (donor.city || '')
  });
  try { await batch.commit(); showToast('Request sent. Waiting for the other side to accept or reject.'); }
  catch (err) { handleFirebaseError(err); }
}

window.sendDonorRequest = (donorUid) => {
  const request = activeRequest();
  const donor = state.donorsAvailable.find((d) => d.id === donorUid);
  createOffer(request, donor, 'patient');
};

window.acceptPatientRequest = (requestId) => {
  const request = state.openRequests.find((r) => r.id === requestId);
  const donor = state.donorProfile;
  if (!donor || donor.status !== 'Available') { showToast('Set your availability to Available first.'); return; }
  createOffer(request, donor, 'donor');
};

// Donor rejects a listed request: it is recorded as Rejected so it stays out of the list ("return to matching requests").
window.rejectPatientRequest = async (requestId) => {
  const request = state.openRequests.find((r) => r.id === requestId);
  const donor = state.donorProfile;
  if (!request || !donor) return;
  try {
    await fb.db.collection('matches').doc(matchIdFor(request.id, donor.id)).set({
      requestId: request.id, patientUid: request.patientUid, donorUid: donor.id,
      patientName: request.patientName, donorName: donor.name,
      patientPhone: request.patientPhone || '', donorPhone: donor.phone || '',
      patientBloodGroup: request.bloodGroup, donorBloodGroup: donor.bloodGroup,
      units: request.units, hospital: request.hospital, urgency: request.urgency, location: request.location,
      initiatedBy: 'donor', status: 'Rejected', createdAt: serverTime()
    });
  } catch (err) { handleFirebaseError(err); }
};

// The receiving side answers: "Donor accepts or rejects?" / "Patient accepts or rejects?"
window.respondToOffer = async (matchId, accept) => {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match || match.status !== 'Pending') return;
  const role = state.currentUser.role;
  const ref = fb.db.collection('matches').doc(matchId);
  const batch = fb.db.batch();
  batch.update(ref, { status: accept ? 'Accepted' : 'Rejected', respondedAt: serverTime() });
  if (accept) {
    batch.set(ref.collection('contact').doc(role), {
      ...myContact(), location: role === 'patient' ? `${match.hospital}, ${match.location}` : (state.donorProfile?.city || state.currentUser.city || '')
    });
    batch.update(fb.db.collection('patientRequests').doc(match.requestId), { status: 'Matched', matchId });
    batch.update(fb.db.collection('donors').doc(match.donorUid), { status: 'Matched', matchId });
  }
  try { await batch.commit(); if (accept) showToast(role === 'patient' ? 'Donor found!' : 'Patient matched!'); }
  catch (err) { handleFirebaseError(err); }
};

// Patient request form
window.openRequestModal = () => { state.showRequestModal = true; renderApp(); };
window.closeModals = () => {
  state.showRequestModal = false; state.showBookingModal = false; state.decision = null;
  renderApp();
};

window.submitRequestForm = async (e) => {
  e.preventDefault();
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const u = state.currentUser;
  try {
    await fb.db.collection('patientRequests').add({
      patientUid: u.uid, patientName: u.name, patientPhone: u.phone || '',
      bloodGroup: val('req-blood-group') || u.bloodGroup, units: Number(val('req-units') || 1),
      hospital: val('req-hospital'), urgency: val('req-urgency') || 'Emergency',
      location: val('req-location') || u.city, notes: val('req-notes'),
      status: 'Open', createdAt: serverTime()
    });
    state.showRequestModal = false;
    renderApp();
  } catch (err) { handleFirebaseError(err); }
};

window.cancelRequest = async (requestId) => {
  try { await fb.db.collection('patientRequests').doc(requestId).update({ status: 'Cancelled' }); }
  catch (err) { handleFirebaseError(err); }
};

window.setDonorAvailability = async (status) => {
  const donor = state.donorProfile;
  const until = donor?.cooldownUntil?.toDate ? donor.cooldownUntil.toDate() : (donor?.cooldownUntil ? new Date(donor.cooldownUntil) : null);
  if (status === 'Available' && until && until > new Date()) {
    showToast(`You cannot become available until ${until.toLocaleDateString()} after your recent donation.`);
    return;
  }
  try { await fb.db.collection('donors').doc(state.currentUser.uid).update({ status }); }
  catch (err) { handleFirebaseError(err); }
};

const activeRequest = () => state.requests.find((r) => r.status === 'Open') || state.requests.find((r) => r.status === 'Matched');

// =========================================================================
// 7. APPOINTMENTS  (Patient/Donor side-nav -> Doctor review -> status back)
// =========================================================================
window.openBookingModal = (service) => { state.bookingService = service; state.showBookingModal = true; renderApp(); };

window.submitBookingForm = async (e) => {
  e.preventDefault();
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const u = state.currentUser;
  try {
    await fb.db.collection('appointments').add({
      requesterUid: u.uid, requesterName: u.name, requesterRole: u.role, bloodGroup: u.bloodGroup || '',
      service: state.bookingService, reason: val('apt-reason'),
      requestedDate: val('apt-date'), requestedTime: val('apt-time'), hospital: val('apt-hospital'),
      status: 'Pending', acceptedTimeSlot: '', doctorNote: '', createdAt: serverTime()
    });
    state.showBookingModal = false;
    renderApp();
  } catch (err) { handleFirebaseError(err); }
};

window.selectAppointment = (id) => { state.selectedApptId = id; renderApp(); };
window.setDoctorFilter = (f) => { state.doctorFilter = f; renderApp(); };
window.openDecision = (id, action) => { state.decision = { id, action }; renderApp(); };
window.selectPresetSlot = (slot) => { const el = document.getElementById('slot-input'); if (el) el.value = slot; };

async function updateAppointment(id, fields) {
  try {
    await fb.db.collection('appointments').doc(id).update({
      ...fields, doctorUid: state.currentUser.uid, doctorName: state.currentUser.name, reviewedAt: serverTime()
    });
  } catch (err) { handleFirebaseError(err); }
}

window.confirmDecision = async () => {
  const d = state.decision;
  if (!d) return;
  if (d.action === 'approve') {
    const slot = (document.getElementById('slot-input')?.value || '').trim();
    if (!slot) { showToast('Enter a time slot to approve.'); return; }
    await updateAppointment(d.id, { status: 'Approved', acceptedTimeSlot: slot, doctorNote: (document.getElementById('note-input')?.value || '').trim() });
  } else {
    await updateAppointment(d.id, { status: 'Rejected', acceptedTimeSlot: '', doctorNote: (document.getElementById('note-input')?.value || '').trim() });
  }
  state.decision = null;
  renderApp();
};

window.markPending = (id) => updateAppointment(id, { status: 'Pending', acceptedTimeSlot: '' });

// =========================================================================
// ICONS (embedded SVG, works offline)
// =========================================================================
const ICONS = {
  droplet: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`,
  dropletOutline: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`,
  home: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  heartHandshake: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`,
  activity: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  users: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  calendar: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>`,
  logout: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,
  check: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  clock: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  shieldCheck: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>`,
  building: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M16 14h.01"/></svg>`,
  arrowRight: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`,
  stethoscope: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/></svg>`,
  user: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  lock: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  mail: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  phone: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  mapPin: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
  filter: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
  plus: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>`,
  close: `<svg class="w-current h-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>`
};

function icon(name, className = 'w-4 h-4') {
  const svg = ICONS[name] || ICONS.droplet;
  return `<span class="inline-flex items-center justify-center shrink-0 ${className}">${svg}</span>`;
}

// =========================================================================
// 8. SMALL UI HELPERS
// =========================================================================
const FONT = "font-['Plus_Jakarta_Sans',sans-serif]";

const bloodBadge = (bg, hex = '#DC2626') =>
  `<div class="w-10 h-10 rounded-xl text-white font-black text-sm flex items-center justify-center font-mono shrink-0" style="background:${hex}">${esc(bg)}</div>`;

const chip = (text, cls) => `<span class="text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border ${cls}">${esc(text)}</span>`;

const emptyState = (iconName, title, text) => `
  <div class="bg-white rounded-3xl p-10 text-center border border-slate-200/90 shadow-xs space-y-3">
    <div class="w-14 h-14 mx-auto rounded-full bg-slate-50 text-slate-400 flex items-center justify-center border border-slate-200">${icon(iconName, 'w-7 h-7 text-slate-400')}</div>
    <h3 class="text-sm font-extrabold text-slate-900">${esc(title)}</h3>
    <p class="text-xs text-slate-500 max-w-md mx-auto">${esc(text)}</p>
  </div>`;

function sectionHeader(title, subtitle, count) {
  return `
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-black text-slate-900 tracking-tight">${esc(title)}</h2>
        ${subtitle ? `<p class="text-xs text-slate-500 mt-0.5">${esc(subtitle)}</p>` : ''}
      </div>
      ${count === undefined ? '' : `<span class="text-xs font-mono font-bold px-2.5 py-1 rounded-xl bg-slate-100 text-slate-700 border border-slate-200">${count}</span>`}
    </div>`;
}

function banner(role, tag, title, text, right = '') {
  const th = THEME[role];
  return `
    <div class="bg-white rounded-3xl p-6 sm:p-7 border border-slate-200/90 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-5">
      <div class="space-y-1.5">
        <div class="flex items-center gap-2">${chip(tag, th.soft)}<span class="text-xs text-slate-500 font-medium">Role locked for this account</span></div>
        <h1 class="text-2xl font-black text-slate-900 tracking-tight">${esc(title)}</h1>
        <p class="text-xs text-slate-500 max-w-xl">${text}</p>
      </div>
      ${right}
    </div>`;
}

const statusStyle = (s) => ({
  Approved: 'bg-emerald-600 text-white', Rejected: 'bg-rose-600 text-white', Pending: 'bg-amber-500 text-white'
}[s] || 'bg-slate-500 text-white');

// =========================================================================
// 9. MAIN RENDER
// =========================================================================
function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  if (!state.authReady) {
    root.innerHTML = `<div class="min-h-screen flex items-center justify-center text-sm text-slate-500 ${FONT}">Loading LifeDrop…</div>`;
    return;
  }
  if (!state.currentUser) {
    root.innerHTML = renderAuthPage();
    return;
  }

  const u = state.currentUser;
  const th = THEME[u.role] || THEME.admin;
  const navItem = (page, label, iconName) => {
    const active = state.page === page;
    return `
      <button onclick="window.appNav('${page}')" class="w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-xs font-bold transition-all cursor-pointer ${active ? 'bg-white text-slate-900 shadow-md' : 'text-white/80 hover:bg-white/10 hover:text-white'}">
        ${icon(iconName, 'w-4 h-4')}<span>${label}</span>
      </button>`;
  };

  const body = u.role === 'admin' ? renderAdminDashboard()
    : u.role === 'doctor' ? renderDoctorDashboard()
    : state.page === 'appointments' ? renderAppointments()
    : u.role === 'patient' ? renderPatientDashboard() : renderDonorDashboard();

  root.innerHTML = `
    <div class="min-h-screen bg-[#F8F9FC] flex ${FONT}">
      <aside class="w-64 text-white flex flex-col justify-between shrink-0 sticky top-0 h-screen select-none z-30" style="background:${th.dark}">
        <div class="p-5 space-y-6">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">${icon('droplet', 'w-6 h-6 text-white')}</div>
            <div>
              <div class="text-lg font-extrabold leading-tight">LIFE DROP</div>
              <div class="text-[10px] text-white/60 font-semibold tracking-wider">BLOOD DONATION MONITOR</div>
            </div>
          </div>

          <div class="p-3 bg-black/20 rounded-2xl border border-white/10 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-bold uppercase tracking-wider text-white/60">${th.label} account</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/15 flex items-center gap-1">${icon('lock', 'w-3 h-3')} Locked</span>
            </div>
            <div class="flex items-center gap-2.5">
              ${u.bloodGroup ? bloodBadge(u.bloodGroup, th.hex) : `<div class="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">${icon(th.icon, 'w-5 h-5')}</div>`}
              <div class="overflow-hidden">
                <div class="font-bold text-xs truncate">${esc(u.name)}</div>
                <div class="text-[11px] text-white/60 truncate">${esc(u.email)}</div>
              </div>
            </div>
          </div>

          <nav class="space-y-1.5">
            ${navItem('dashboard', `${th.label} Dashboard`, 'home')}
            ${u.role === 'doctor' || u.role === 'admin' ? '' : navItem('appointments', 'Doctor Appointment', 'calendar')}
          </nav>
        </div>

        <div class="p-5 border-t border-white/10 space-y-3">
          <div class="text-[10px] font-mono text-white/70 flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full ${fb.isConnected ? 'bg-emerald-400' : 'bg-red-400'}"></span>
            ${fb.isConnected ? `Firebase: ${fb.projectId}` : 'Firebase unavailable'}
          </div>
          <button onclick="window.appLogout()" class="w-full py-2.5 px-3 border border-white/25 hover:bg-white/10 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer">
            ${icon('logout', 'w-3.5 h-3.5')}<span>Log Out</span>
          </button>
        </div>
      </aside>

      <main class="flex-1 min-w-0 p-6 sm:p-8 max-w-6xl w-full mx-auto">${body}</main>
      ${renderModals()}
      ${state.toast ? `<div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-slate-900 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-xl max-w-md">${esc(state.toast)}</div>` : ''}
    </div>`;
}

// =========================================================================
// 10. AUTH SCREEN  (Login / Register -> Choose ONE role -> account details)
// =========================================================================
function renderAuthPage() {
  const reg = state.authMode === 'register';
  const role = state.portalRole;
  const th = THEME[role];
  const field = (id, label, type = 'text', extra = '') => `
    <div>
      <label class="block font-bold text-slate-700 mb-1">${label}</label>
      <input id="${id}" type="${type}" required ${extra} class="w-full px-3 py-2.5 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2" style="--tw-ring-color:${th.hex}" />
    </div>`;

  return `
    <div class="min-h-screen bg-[#F8F9FC] flex flex-col justify-center items-center py-10 px-4 ${FONT}">
      <div class="w-full max-w-xl space-y-4">
        <div class="text-center space-y-1">
          <div class="inline-flex w-14 h-14 rounded-2xl bg-red-600 text-white items-center justify-center shadow-lg shadow-red-500/30">${icon('droplet', 'w-8 h-8 text-white')}</div>
          <h1 class="text-3xl font-black text-[#151D48] tracking-tight">LIFE DROP</h1>
          <p class="text-[11px] font-bold tracking-[0.3em] text-slate-500">CONNECT • DONATE • SAVE LIVES</p>
        </div>

        ${role === 'admin' ? `
          <div class="bg-white p-1 rounded-2xl border border-slate-200/90">
            <div class="py-2.5 rounded-xl text-xs font-bold text-center bg-[#151D48] text-white">Admin Sign In Only</div>
          </div>` : `
          <div class="bg-white p-1 rounded-2xl border border-slate-200/90 flex gap-1">
            ${['signin', 'register'].map((m) => `
              <button type="button" onclick="window.setAuthMode('${m}')" class="flex-1 py-2.5 rounded-xl text-xs font-bold cursor-pointer ${state.authMode === m ? 'bg-[#151D48] text-white' : 'text-slate-600 hover:bg-slate-50'}">
                ${m === 'signin' ? 'Login' : 'Register'}
              </button>`).join('')}
          </div>`}

        <div>
          <div class="text-xs font-bold text-slate-700 mb-2 text-center">Choose ONE role</div>
          <div class="grid grid-cols-4 gap-2">
            ${['patient', 'donor', 'doctor', 'admin'].map((r) => {
              const t = THEME[r]; const on = r === role;
              return `
              <button type="button" onclick="window.setPortalRole('${r}')" class="p-3 rounded-2xl border-2 text-xs font-extrabold flex flex-col items-center gap-1.5 cursor-pointer transition-all ${on ? 'bg-white shadow-md' : 'bg-white/60 border-slate-200 text-slate-600'}" style="${on ? `border-color:${t.hex};color:${t.hex}` : ''}">
                <span class="w-9 h-9 rounded-full text-white flex items-center justify-center" style="background:${t.hex}">${icon(t.icon, 'w-5 h-5 text-white')}</span>
                ${t.label.toUpperCase()}
              </button>`;
            }).join('')}
          </div>
        </div>

        <div class="bg-white rounded-3xl shadow-xl border border-slate-200/80 overflow-hidden">
          <div class="text-white px-6 py-4" style="background:${th.hex}">
            <div class="text-[10px] font-black uppercase tracking-widest text-white/70">${reg ? 'Register' : 'Login'} • ${th.label}</div>
            <h2 class="text-lg font-black">${reg ? `Create ${th.label} Account` : `${th.label} Sign In`}</h2>
          </div>
          <form onsubmit="window.submitAuth(event)" class="p-6 space-y-3.5 text-xs">
            ${reg ? field('auth-name', 'Full Name') : ''}
            ${field('auth-email', 'Email', 'email', 'autocomplete="email"')}
            ${field('auth-password', 'Password', 'password', `minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"`)}
            ${reg ? `<div class="grid grid-cols-2 gap-3">${field('auth-phone', 'Phone Number', 'tel')}${field('auth-city', 'City / Region')}</div>` : ''}
            ${reg && role === 'doctor' ? `<div class="grid grid-cols-2 gap-3">${field('auth-license', 'Medical License #')}${field('auth-hospital', 'Hospital / Clinic')}</div>` : ''}
            ${reg && role !== 'doctor' ? `
              <div>
                <div class="flex items-center justify-between mb-1.5"><label class="font-bold text-slate-700">Your Blood Group</label><span class="text-[11px] font-bold" style="color:${th.hex}">Used for compatibility matching</span></div>
                <div class="grid grid-cols-4 gap-2">
                  ${BLOOD_GROUPS.map((bg) => `
                    <button type="button" onclick="window.selectRegBlood('${bg}')" class="py-2 font-black rounded-xl border font-mono cursor-pointer ${state.regBlood === bg ? 'text-white' : 'bg-white text-slate-700 border-slate-200'}" style="${state.regBlood === bg ? `background:${th.hex};border-color:${th.hex}` : ''}">${bg}</button>`).join('')}
                </div>
              </div>` : ''}
            ${reg ? `<p class="p-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-600 flex gap-2">${icon('lock', 'w-4 h-4 shrink-0 text-slate-500')}<span>Your role is locked to this account after registration. There is no switching roles after login.</span></p>` : ''}
            ${state.authError ? `<p class="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 font-semibold">${esc(state.authError)}</p>` : ''}
            ${!fb.isConnected ? `<p class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 font-semibold">Firebase SDK could not load (check internet and the script tags in index.html).</p>` : ''}
            <button type="submit" ${state.authBusy ? 'disabled' : ''} class="w-full py-3.5 text-white font-extrabold rounded-xl shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60" style="background:${th.hex}">
              <span>${state.authBusy ? 'Please wait…' : reg ? 'Register & Authenticate' : 'Authenticate'}</span>${icon('arrowRight', 'w-4 h-4')}
            </button>
          </form>
        </div>
      </div>
    </div>`;
}

// =========================================================================
// 11. PATIENT FLOW
//   Dashboard -> view only matching donors -> check compatibility
//   -> select donor / send request -> donor accepts or rejects
//   -> DONOR FOUND (share contact securely)  |  rejected: back to the list
// =========================================================================
function matchedCard(match, role) {
  const other = role === 'patient' ? 'donor' : 'patient';
  const contact = state.contacts[match.id]?.[other];
  const th = THEME[other === 'donor' ? 'donor' : 'patient'];
  const name = other === 'donor' ? match.donorName : match.patientName;
  return `
    <div class="rounded-3xl border-2 p-6 space-y-4 ${other === 'donor' ? 'bg-emerald-50/70 border-emerald-300' : 'bg-emerald-50/70 border-emerald-300'}">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center">${icon('check', 'w-7 h-7 text-white')}</div>
        <div>
          <div class="text-lg font-black text-emerald-900">${role === 'patient' ? 'DONOR FOUND' : 'PATIENT MATCHED'}</div>
          <div class="text-xs text-emerald-800">Necessary contact / location details are shared securely.</div>
        </div>
      </div>
      <div class="bg-white rounded-2xl border border-emerald-200 p-4 grid sm:grid-cols-2 gap-3 text-xs">
        <div><div class="text-slate-500">${other === 'donor' ? 'Donor' : 'Patient'}</div><div class="font-extrabold text-slate-900 text-sm">${esc(name)}</div></div>
        <div><div class="text-slate-500">Blood group</div><div class="font-black font-mono" style="color:${th.hex}">${esc(other === 'donor' ? match.donorBloodGroup : match.patientBloodGroup)}</div></div>
        <div><div class="text-slate-500">Phone</div><div class="font-bold font-mono text-slate-900">${contact ? esc(contact.phone) : 'Loading…'}</div></div>
        <div><div class="text-slate-500">Location</div><div class="font-bold text-slate-900">${contact ? esc(contact.location) : 'Loading…'}</div></div>
        <div><div class="text-slate-500">Hospital</div><div class="font-bold text-slate-900">${esc(match.hospital)}</div></div>
        <div><div class="text-slate-500">Units</div><div class="font-bold text-slate-900">${esc(match.units)}</div></div>
      </div>
    </div>`;
}

function offerRow(match, role) {
  // An incoming offer waiting for MY accept / reject.
  const otherName = role === 'patient' ? match.donorName : match.patientName;
  const otherBg = role === 'patient' ? match.donorBloodGroup : match.patientBloodGroup;
  const sub = role === 'patient' ? 'Donor wants to donate to you' : `${match.units} unit(s) • ${match.hospital} • ${match.urgency}`;
  return `
    <div class="bg-white rounded-3xl p-5 border border-slate-200 shadow-xs flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">${bloodBadge(otherBg, THEME[role === 'patient' ? 'donor' : 'patient'].hex)}
        <div><h4 class="font-extrabold text-sm text-slate-900">${esc(otherName)}</h4><span class="text-[11px] text-slate-500">${esc(sub)}</span></div>
      </div>
      <div class="flex gap-2">
        <button onclick="window.respondToOffer('${esc(match.id)}', false)" class="px-4 py-2 border border-rose-300 text-rose-700 hover:bg-rose-50 font-bold text-xs rounded-xl cursor-pointer">Reject</button>
        <button onclick="window.respondToOffer('${esc(match.id)}', true)" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl cursor-pointer">Accept</button>
      </div>
    </div>`;
}

function renderPatientDashboard() {
  const u = state.currentUser;
  const req = activeRequest();
  const accepted = req && state.matches.find((m) => m.requestId === req.id && m.status === 'Accepted');
  const forThisReq = req ? state.matches.filter((m) => m.requestId === req.id) : [];
  const incoming = forThisReq.filter((m) => m.initiatedBy === 'donor' && m.status === 'Pending');
  const sent = forThisReq.filter((m) => m.initiatedBy === 'patient' && m.status === 'Pending');
  const declined = forThisReq.filter((m) => m.initiatedBy === 'patient' && m.status === 'Rejected').length;
  const touched = new Set(forThisReq.map((m) => m.donorUid));

  const donors = req && !accepted
    ? state.donorsAvailable
        .filter((d) => {
          const until = d.cooldownUntil?.toDate ? d.cooldownUntil.toDate() : (d.cooldownUntil ? new Date(d.cooldownUntil) : null);
          return (!until || until <= new Date()) && d.status === 'Available' && bloodGroupCanDonate(d.bloodGroup, req.bloodGroup) && !touched.has(d.id);
        })
        .sort((a, b) => Number((b.city || '').toLowerCase() === (req.location || '').toLowerCase()) - Number((a.city || '').toLowerCase() === (req.location || '').toLowerCase()))
    : [];

  return `
    <div class="space-y-6 pb-12">
      ${banner('patient', 'PATIENT DASHBOARD', 'Find a Matching Donor',
        'You only see available donors whose blood group is compatible with your request. Send a request and wait for the donor to accept or reject.',
        `<div class="bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80 flex items-center gap-3 shrink-0">${bloodBadge(req ? req.bloodGroup : u.bloodGroup)}<div><div class="text-[10px] font-black uppercase tracking-wider text-slate-400">${req ? 'REQUIRED BLOOD GROUP' : 'YOUR BLOOD GROUP'}</div><div class="text-xs font-extrabold text-[#151D48]">${esc(u.name)}</div></div></div>`)}

      ${!req ? `
        <div class="bg-white rounded-3xl p-8 text-center border-2 border-dashed border-rose-200 space-y-3">
          <h3 class="text-base font-extrabold text-slate-900">No active blood request</h3>
          <p class="text-xs text-slate-500">Publish a request to see compatible donors.</p>
          <button onclick="window.openRequestModal()" class="px-5 py-3 bg-red-600 hover:bg-red-700 text-white font-extrabold text-xs rounded-xl shadow-md cursor-pointer">Create Blood Request</button>
        </div>` : `
        <div class="bg-white rounded-3xl p-5 border border-rose-200 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div><div class="font-black text-slate-900 text-sm">${esc(req.bloodGroup)} • ${esc(req.units)} unit(s) • ${esc(req.urgency)}</div>
            <div class="text-slate-500">${esc(req.hospital)}, ${esc(req.location)}</div></div>
          <div class="flex items-center gap-2 flex-wrap">${chip(req.status, req.status === 'Matched' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700')}
            ${req.status === 'Open' ? `<button onclick="window.cancelRequest('${esc(req.id)}')" class="px-3 py-1.5 border border-slate-300 text-slate-700 font-bold rounded-xl cursor-pointer">Cancel request</button>` : ''}
            ${req.status === 'Matched' ? `<button onclick="window.openRequestModal()" class="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl cursor-pointer">Create New Request</button>` : ''}</div>
        </div>`}

      ${accepted ? matchedCard(accepted, 'patient') : ''}

      ${req && !accepted ? `
        ${incoming.length ? `<section class="space-y-3">${sectionHeader('Donors who offered to help', 'Accept or reject each offer', incoming.length)}${incoming.map((m) => offerRow(m, 'patient')).join('')}</section>` : ''}
        ${sent.length ? `<section class="space-y-3">${sectionHeader('Awaiting donor response', '', sent.length)}
          ${sent.map((m) => `<div class="bg-white rounded-2xl p-4 border border-amber-200 text-xs flex items-center justify-between"><span class="font-bold text-slate-900">${esc(m.donorName)} <span class="font-mono text-slate-500">(${esc(m.donorBloodGroup)})</span></span>${chip('Request sent', 'bg-amber-50 border-amber-200 text-amber-700')}</div>`).join('')}</section>` : ''}

        <section class="space-y-3">
          ${sectionHeader('Available matching donors', declined ? `${declined} donor(s) declined and were removed from this list` : 'Compatible with your required blood group', donors.length)}
          ${donors.length === 0 ? emptyState('dropletOutline', 'No matching donors right now', 'Compatible, available donors will appear here in real time.') : `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${donors.map((d) => `
              <div class="bg-white rounded-3xl p-5 border border-slate-200 shadow-xs space-y-3">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2.5">${bloodBadge(d.bloodGroup, THEME.donor.hex)}
                    <div><h4 class="font-extrabold text-sm text-slate-900">${esc(d.name)}</h4><span class="text-[11px] text-slate-500">${esc(d.city)}${(d.city || '').toLowerCase() === (req.location || '').toLowerCase() ? ' • same city' : ''}</span></div></div>
                  ${chip('Compatible', 'bg-emerald-50 border-emerald-200 text-emerald-700')}
                </div>
                <div class="text-xs text-slate-600">Availability: <strong>${esc(d.availability || 'Immediate')}</strong></div>
                <button onclick="window.sendDonorRequest('${esc(d.id)}')" class="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl shadow-xs cursor-pointer">Send Request</button>
              </div>`).join('')}
          </div>`}
        </section>` : ''}
    </div>`;
}

// =========================================================================
// 12. DONOR FLOW
//   Dashboard -> view only matching patient requests -> check compatibility
//   -> select patient / accept or reject -> patient accepts or rejects
//   -> PATIENT MATCHED (share contact securely) | rejected: back to the list
// =========================================================================
function renderDonorDashboard() {
  const u = state.currentUser;
  const donor = state.donorProfile;
  const accepted = state.matches.find((m) => m.status === 'Accepted');
  const incoming = state.matches.filter((m) => m.initiatedBy === 'patient' && m.status === 'Pending');
  const sent = state.matches.filter((m) => m.initiatedBy === 'donor' && m.status === 'Pending');
  const touched = new Set(state.matches.map((m) => m.requestId));
  const cooldownUntil = donor?.cooldownUntil?.toDate ? donor.cooldownUntil.toDate() : (donor?.cooldownUntil ? new Date(donor.cooldownUntil) : null);
  const coolingDown = Boolean(cooldownUntil && cooldownUntil > new Date());
  const available = donor && donor.status === 'Available' && !coolingDown;

  const requests = !accepted && available
    ? state.openRequests.filter((r) => bloodGroupCanDonate(donor.bloodGroup, r.bloodGroup) && !touched.has(r.id))
    : [];

  return `
    <div class="space-y-6 pb-12">
      ${banner('donor', 'DONOR DASHBOARD', 'Matching Patient Requests',
        'You only see open requests that your blood group can safely fulfil. Accept or reject; the patient then confirms the match.',
        `<div class="bg-slate-50 p-3.5 rounded-2xl border border-slate-200/80 flex items-center gap-3 shrink-0">${bloodBadge(u.bloodGroup, THEME.donor.hex)}
          <div><div class="text-[10px] font-black uppercase tracking-wider text-slate-400">AVAILABILITY</div>
          ${donor ? (donor.status === 'Matched'
              ? `<div class="text-xs font-extrabold text-emerald-700">Matched • temporarily unavailable</div>`
              : `<select aria-label="Donor availability" onchange="window.setDonorAvailability(this.value)" class="text-xs font-extrabold bg-transparent text-[#151D48] focus:outline-none cursor-pointer"><option value="Available" ${donor.status === 'Available' ? 'selected' : ''}>Available</option><option value="Unavailable" ${donor.status === 'Unavailable' ? 'selected' : ''}>Unavailable</option></select>`)
              : `<div class="text-xs font-extrabold text-slate-500">Loading…</div>`}</div></div>`)}

      ${coolingDown ? `<div class="p-4 rounded-2xl border border-amber-300 bg-amber-50 text-amber-900 text-xs"><div class="font-extrabold text-sm">Recent donation recorded</div><p class="mt-1">Admin recorded your recent blood donation. You cannot appear in patient matching until ${esc(cooldownUntil.toLocaleDateString())} (90-day recovery period). Availability changes are blocked during this period.</p></div>` : ''}
      ${accepted ? matchedCard(accepted, 'donor') : ''}

      ${!accepted ? `
        ${incoming.length ? `<section class="space-y-3">${sectionHeader('Requests sent to you', 'Accept or reject each request', incoming.length)}${incoming.map((m) => offerRow(m, 'donor')).join('')}</section>` : ''}
        ${sent.length ? `<section class="space-y-3">${sectionHeader('Awaiting patient response', '', sent.length)}
          ${sent.map((m) => `<div class="bg-white rounded-2xl p-4 border border-amber-200 text-xs flex items-center justify-between"><span class="font-bold text-slate-900">${esc(m.patientName)} <span class="font-mono text-slate-500">(${esc(m.patientBloodGroup)})</span></span>${chip('Offer sent', 'bg-amber-50 border-amber-200 text-amber-700')}</div>`).join('')}</section>` : ''}

        <section class="space-y-3">
          ${sectionHeader('Matching patient blood requests', available ? 'Compatible with your blood group' : 'Set yourself to Available to see requests', requests.length)}
          ${requests.length === 0 ? emptyState('check', coolingDown ? 'Donation recovery period active' : (!available ? 'Set availability to Available' : 'No matching requests'), coolingDown ? `Admin recorded a recent donation. Matching will resume after ${esc(cooldownUntil.toLocaleDateString())}.` : (!available ? 'Your account is currently unavailable for matching.' : 'New open, compatible patient requests will appear here in real time.')) : `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${requests.map((r) => `
              <div class="bg-white rounded-3xl p-5 border border-slate-200 shadow-xs space-y-3">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2.5">${bloodBadge(r.bloodGroup, THEME.patient.hex)}
                    <div><h4 class="font-extrabold text-sm text-slate-900">${esc(r.patientName)}</h4><span class="text-[11px] text-slate-500">${esc(r.hospital)}</span></div></div>
                  ${chip(r.urgency, 'bg-rose-50 border-rose-200 text-red-700')}
                </div>
                <div class="text-xs text-slate-600"><div>Units: <strong>${esc(r.units)}</strong></div><div>Location: ${esc(r.location)}</div>${r.notes ? `<div class="text-slate-500">${esc(r.notes)}</div>` : ''}</div>
                <div class="flex gap-2">
                  <button onclick="window.rejectPatientRequest('${esc(r.id)}')" class="flex-1 py-2.5 border border-rose-300 text-rose-700 hover:bg-rose-50 font-bold text-xs rounded-xl cursor-pointer">Reject</button>
                  <button onclick="window.acceptPatientRequest('${esc(r.id)}')" class="flex-1 py-2.5 bg-green-600 hover:bg-green-700 text-white font-bold text-xs rounded-xl shadow-xs cursor-pointer">Accept</button>
                </div>
              </div>`).join('')}
          </div>`}
        </section>` : ''}
    </div>`;
}

// =========================================================================
// 13. DOCTOR APPOINTMENT  (patient/donor side-nav, form -> status updates)
// =========================================================================
function renderAppointments() {
  const role = state.currentUser.role;
  const services = [
    ['Health Check', 'Pre-donation or general health screening.', 'stethoscope'],
    ['Consultation', 'One-on-one session with a doctor.', 'users'],
    ['Blood Test', 'CBC, ABO/Rh typing and screening.', 'droplet']
  ];
  return `
    <div class="space-y-6 pb-12">
      ${banner(role, 'DOCTOR APPOINTMENT', 'Health Check / Consultation',
        'Submit an appointment form. A doctor reviews it and approves, rejects or keeps it pending; the updated status appears below instantly.')}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div class="space-y-4">
          ${sectionHeader('Book an appointment', 'Choose a service')}
          ${services.map(([name, desc, ic]) => `
            <div class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-xs flex items-center justify-between gap-3">
              <div class="flex items-center gap-3"><div class="w-11 h-11 rounded-2xl bg-blue-50 text-blue-700 flex items-center justify-center">${icon(ic, 'w-5 h-5')}</div>
                <div><h3 class="font-black text-sm text-slate-900">${name}</h3><p class="text-xs text-slate-500">${desc}</p></div></div>
              <button onclick="window.openBookingModal('${name}')" class="px-4 py-2 text-white font-bold text-xs rounded-xl cursor-pointer shrink-0" style="background:${THEME[role].hex}">Book</button>
            </div>`).join('')}
        </div>
        <div class="space-y-4">
          ${sectionHeader('Appointment status', 'Updated by the doctor in real time', state.appointments.length)}
          ${state.appointments.length === 0 ? emptyState('calendar', 'No appointments yet', 'Your submitted appointments and their status will appear here.') : state.appointments.map((a) => `
            <div class="bg-white rounded-2xl p-4 border ${a.status === 'Approved' ? 'border-emerald-300' : a.status === 'Rejected' ? 'border-rose-300' : 'border-amber-300'} text-xs space-y-1.5">
              <div class="flex items-center justify-between"><span class="font-black uppercase tracking-wider text-slate-700">${esc(a.service)}</span><span class="px-2 py-0.5 rounded-full font-bold ${statusStyle(a.status)}">${esc(a.status)}</span></div>
              <div class="text-slate-500">Requested: ${esc(a.requestedDate)} (${esc(a.requestedTime)}) • ${esc(a.hospital)}</div>
              ${a.status === 'Approved' && a.acceptedTimeSlot ? `<div class="p-2.5 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-900"><strong>Confirmed slot:</strong> ${esc(a.acceptedTimeSlot)}</div>` : ''}
              ${a.doctorNote ? `<div class="text-slate-600"><strong>Doctor's note:</strong> ${esc(a.doctorNote)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

// =========================================================================
// 14. ADMIN FLOW — review matches and record completed donations
// =========================================================================
function renderAdminDashboard() {
  const donors = state.adminDonors || [];
  const matches = state.adminMatches || [];
  const requests = state.adminRequests || [];
  const accepted = matches.filter((m) => m.status === 'Accepted');
  const completed = matches.filter((m) => m.donationRecorded === true);
  const now = new Date();
  const donorStatus = (d) => {
    const until = d.cooldownUntil?.toDate ? d.cooldownUntil.toDate() : (d.cooldownUntil ? new Date(d.cooldownUntil) : null);
    return until && until > now ? `Cooldown until ${until.toLocaleDateString()}` : (d.status || 'Unknown');
  };
  return `
    <div class="space-y-6 pb-12">
      ${banner('admin', 'ADMIN CONTROL PANEL', 'Blood Donation Matching Dashboard',
        'Review patient–donor matches and record a donation only after it is confirmed.',
        `<div class="flex flex-wrap gap-2 text-xs font-bold"><div class="px-3 py-2 rounded-xl bg-violet-50 text-violet-800 border border-violet-200">Donors: ${donors.length}</div><div class="px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-200">Accepted matches: ${accepted.length}</div><div class="px-3 py-2 rounded-xl bg-blue-50 text-blue-800 border border-blue-200">Donations recorded: ${completed.length}</div></div>`)}

      <section class="space-y-3">
        ${sectionHeader('Matched patients and donors', 'Confirm donation after the hospital verifies it', accepted.length)}
        ${accepted.length ? `<div class="space-y-3">${accepted.map((m) => `
          <div class="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
            <div class="space-y-1">
              <div class="font-extrabold text-sm text-slate-900">${esc(m.donorName)} <span class="font-mono text-emerald-700">(${esc(m.donorBloodGroup)})</span> <span class="text-slate-400">→</span> ${esc(m.patientName)} <span class="font-mono text-rose-700">(${esc(m.patientBloodGroup)})</span></div>
              <div class="text-slate-500">${esc(m.hospital || 'Hospital not specified')} • ${esc(m.location || '')} • ${esc(m.units || 1)} unit(s)</div>
               <div class="text-slate-600">Donor phone: <strong class="font-mono">${esc(m.donorPhone || 'Not provided')}</strong> • Patient phone: <strong class="font-mono">${esc(m.patientPhone || 'Not provided')}</strong></div>
              <div class="text-slate-500">Status: ${m.donationRecorded ? chip('Donation recorded', 'bg-violet-50 border-violet-200 text-violet-700') : chip('Awaiting confirmation', 'bg-amber-50 border-amber-200 text-amber-700')}</div>
              ${m.donationRecordedAt ? `<div class="text-slate-500">Recorded: ${esc(m.donationRecordedAt.toDate ? m.donationRecordedAt.toDate().toLocaleString() : m.donationRecordedAt)}</div>` : ''}
            </div>
            ${m.donationRecorded ? `<div class="px-3 py-2 rounded-xl bg-violet-50 border border-violet-200 text-violet-800 font-bold">Completed</div>` :
              `<button onclick="window.recordDonation('${esc(m.id)}')" class="px-4 py-2.5 rounded-xl bg-violet-700 hover:bg-violet-800 text-white font-bold cursor-pointer">Confirm Blood Donated</button>`}
          </div>`).join('')}</div>` : emptyState('dropletOutline', 'No accepted matches yet', 'Accepted patient–donor matches will appear here.') }
      </section>

      <section class="space-y-3">
        ${sectionHeader('Donor records', 'Recent donors are blocked from new patient requests', donors.length)}
        ${donors.length ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">${donors.map((d) => {
          const until = d.cooldownUntil?.toDate ? d.cooldownUntil.toDate() : (d.cooldownUntil ? new Date(d.cooldownUntil) : null);
          const cooling = until && until > now;
          return `<div class="bg-white rounded-2xl border border-slate-200 p-4 text-xs space-y-2">
            <div class="flex justify-between gap-3"><div><div class="font-extrabold text-sm text-slate-900">${esc(d.name || 'Donor')}</div><div class="text-slate-500">${esc(d.city || 'City not set')}</div><div class="text-slate-600 mt-1">Phone: <strong class="font-mono">${esc(d.phone || 'Not provided')}</strong></div></div>${bloodBadge(d.bloodGroup, THEME.donor.hex)}</div>
            <div class="flex items-center justify-between"><span class="text-slate-500">Availability</span><strong class="${cooling ? 'text-amber-700' : d.status === 'Available' ? 'text-emerald-700' : 'text-slate-700'}">${esc(donorStatus(d))}</strong></div>
            <div class="text-slate-500">Last donation: ${d.lastDonationAt ? esc(d.lastDonationAt.toDate ? d.lastDonationAt.toDate().toLocaleDateString() : d.lastDonationAt) : 'Not recorded'}</div>
          </div>`;
        }).join('')}</div>` : emptyState('users', 'No donor records', 'Registered donors will appear here.') }
      </section>

      <section class="space-y-3">
        ${sectionHeader('Recent patient requests', 'Request status', requests.length)}
        <div class="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
          ${requests.length ? requests.slice(0, 10).map((r) => `<div class="p-3 text-xs flex items-center justify-between gap-3"><div><div class="font-bold text-slate-900">${esc(r.patientName)} • ${esc(r.bloodGroup)}</div><div class="text-slate-500">${esc(r.hospital || '')} • ${esc(r.location || '')}</div></div>${chip(r.status, r.status === 'Matched' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-slate-50 border-slate-200 text-slate-700')}</div>`).join('') : `<div class="p-4 text-xs text-slate-500">No patient requests yet.</div>`}
        </div>
      </section>
    </div>`;
}

window.recordDonation = async (matchId) => {
  if (state.currentUser?.role !== 'admin') { showToast('Admin access required.'); return; }
  const match = (state.adminMatches || []).find((m) => m.id === matchId);
  if (!match || match.status !== 'Accepted' || match.donationRecorded) {
    showToast('Only an unrecorded accepted match can be marked as donated.');
    return;
  }
  const cooldownUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const now = serverTime();
  const batch = fb.db.batch();
  batch.update(fb.db.collection('donors').doc(match.donorUid), {
    status: 'Unavailable', availability: 'Unavailable', lastDonationAt: now,
    cooldownUntil: window.firebase.firestore.Timestamp.fromDate(cooldownUntil),
    lastDonationMatchId: matchId
  });
  batch.update(fb.db.collection('matches').doc(matchId), {
    donationRecorded: true, donationRecordedAt: now,
    donationRecordedBy: state.currentUser.uid, cooldownDays: 90
  });
  try {
    await batch.commit();
    showToast(`${match.donorName} marked as donated. Unavailable for 90 days.`);
  } catch (err) { handleFirebaseError(err); }
};

// =========================================================================
// 14. DOCTOR FLOW
//   Dashboard -> view patient & donor appointment requests -> review details
//   -> Approve | Reject | Pending -> requester sees updated status
// =========================================================================
function renderDoctorDashboard() {
  const f = state.doctorFilter;
  const list = state.appointments.filter((a) => f === 'All' || a.requesterRole === f.toLowerCase() || a.status === f);
  const selected = state.appointments.find((a) => a.id === state.selectedApptId);
  const count = (s) => state.appointments.filter((a) => a.status === s).length;

  return `
    <div class="space-y-6 pb-12">
      ${banner('doctor', 'DOCTOR DASHBOARD', `${esc(state.currentUser.name)}`,
        `${esc(state.currentUser.hospital || 'Hospital')} • Review patient and donor appointment requests.`,
        `<div class="flex gap-2 text-xs font-bold">${['Pending', 'Approved', 'Rejected'].map((s) => `<div class="px-3 py-2 rounded-xl ${statusStyle(s)}">${s}: ${count(s)}</div>`).join('')}</div>`)}

      <div class="bg-white p-4 rounded-2xl border border-slate-200/80 flex flex-wrap items-center gap-1.5 text-xs">
        <span class="font-bold text-slate-700 mr-2">Filter:</span>
        ${['All', 'Patient', 'Donor', 'Pending', 'Approved', 'Rejected'].map((x) => `
          <button onclick="window.setDoctorFilter('${x}')" class="px-3 py-1.5 rounded-xl font-bold cursor-pointer ${f === x ? 'bg-blue-700 text-white' : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'}">${x}</button>`).join('')}
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <div class="lg:col-span-3 space-y-3">
          ${list.length === 0 ? emptyState('calendar', 'No appointment requests', 'Requests from patients and donors appear here in real time.') : list.map((a) => `
            <button onclick="window.selectAppointment('${esc(a.id)}')" class="w-full text-left bg-white rounded-2xl p-4 border ${a.id === state.selectedApptId ? 'border-blue-600 ring-2 ring-blue-200' : 'border-slate-200'} text-xs flex items-center justify-between gap-3 cursor-pointer hover:shadow-md transition-shadow">
              <div><div class="font-black text-sm text-slate-900">${esc(a.requesterName)} ${chip(a.requesterRole, THEME[a.requesterRole]?.soft || '')}</div>
                <div class="text-slate-500 mt-0.5">${esc(a.service)} • ${esc(a.requestedDate)} (${esc(a.requestedTime)})</div></div>
              <span class="px-2 py-0.5 rounded-full font-bold ${statusStyle(a.status)}">${esc(a.status)}</span>
            </button>`).join('')}
        </div>

        <div class="lg:col-span-2 bg-white rounded-3xl p-6 border border-slate-200/90 shadow-xs space-y-4 text-xs sticky top-6">
          ${!selected ? `<div class="text-center text-slate-500 py-8">Select a request to review its details.</div>` : `
            <div class="flex items-center justify-between"><h3 class="font-black text-base text-slate-900">Review details</h3><span class="px-2 py-0.5 rounded-full font-bold ${statusStyle(selected.status)}">${esc(selected.status)}</span></div>
            <div class="space-y-2 divide-y divide-slate-100">
              ${[['Requested by', `${selected.requesterName} (${selected.requesterRole})`], ['Blood group', selected.bloodGroup || '-'], ['Service', selected.service],
                 ['Preferred date', `${selected.requestedDate} ${selected.requestedTime}`], ['Hospital', selected.hospital], ['Reason / notes', selected.reason || '-'],
                 ...(selected.acceptedTimeSlot ? [['Confirmed slot', selected.acceptedTimeSlot]] : []), ...(selected.doctorNote ? [['Doctor note', selected.doctorNote]] : [])]
                .map(([k, v]) => `<div class="pt-2 flex justify-between gap-4"><span class="text-slate-500">${k}</span><span class="font-bold text-slate-900 text-right">${esc(v)}</span></div>`).join('')}
            </div>
            <div class="grid grid-cols-3 gap-2 pt-2">
              <button onclick="window.openDecision('${esc(selected.id)}','approve')" class="py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl cursor-pointer">Approve</button>
              <button onclick="window.openDecision('${esc(selected.id)}','reject')" class="py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl cursor-pointer">Reject</button>
              <button onclick="window.markPending('${esc(selected.id)}')" class="py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl cursor-pointer">Pending</button>
            </div>`}
        </div>
      </div>
    </div>`;
}

// =========================================================================
// 15. MODALS
// =========================================================================
function modalShell(headerHex, tag, title, inner) {
  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div class="bg-white rounded-3xl max-w-lg w-full shadow-2xl overflow-hidden modal-animate ${FONT}">
        <div class="text-white px-6 py-4 flex items-center justify-between" style="background:${headerHex}">
          <div><span class="text-[10px] font-black uppercase tracking-wider text-white/70 block">${tag}</span><h3 class="text-lg font-black">${title}</h3></div>
          <button onclick="window.closeModals()" class="text-white/80 hover:text-white cursor-pointer">${icon('close', 'w-5 h-5')}</button>
        </div>
        ${inner}
      </div>
    </div>`;
}

const inputCls = 'w-full px-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-400';
const footerBtns = (label, hex) => `
  <div class="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
    <button type="button" onclick="window.closeModals()" class="px-4 py-2 font-bold text-slate-600 cursor-pointer">Cancel</button>
    <button type="submit" class="px-5 py-2.5 text-white font-extrabold rounded-xl shadow-md cursor-pointer" style="background:${hex}">${label}</button>
  </div>`;

function renderModals() {
  const u = state.currentUser;
  let html = '';

  if (state.showRequestModal) {
    html += modalShell(THEME.patient.hex, 'PATIENT FORM • REQUEST BLOOD', 'Blood Request', `
      <form onsubmit="window.submitRequestForm(event)" class="p-6 space-y-3.5 text-xs">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block font-bold text-slate-700 mb-1">Blood Group Required</label>
            <select id="req-blood-group" class="${inputCls} font-bold font-mono">${BLOOD_GROUPS.map((bg) => `<option value="${bg}" ${bg === u.bloodGroup ? 'selected' : ''}>${bg}</option>`).join('')}</select></div>
          <div><label class="block font-bold text-slate-700 mb-1">Units Needed</label><input id="req-units" type="number" min="1" max="10" value="1" class="${inputCls} font-bold" /></div>
        </div>
        <div><label class="block font-bold text-slate-700 mb-1">Hospital / Medical Center</label><input id="req-hospital" type="text" required class="${inputCls}" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block font-bold text-slate-700 mb-1">Urgency</label>
            <select id="req-urgency" class="${inputCls}"><option>Emergency</option><option>Urgent</option><option>Standard</option></select></div>
          <div><label class="block font-bold text-slate-700 mb-1">Location</label><input id="req-location" type="text" required value="${esc(u.city)}" class="${inputCls}" /></div>
        </div>
        <div><label class="block font-bold text-slate-700 mb-1">Clinical Notes (optional)</label><textarea id="req-notes" rows="2" class="${inputCls}"></textarea></div>
        ${footerBtns('Publish Request', THEME.patient.hex)}
      </form>`);
  }

  if (state.showBookingModal) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    html += modalShell(THEME[u.role].hex, 'APPOINTMENT FORM', esc(state.bookingService), `
      <form onsubmit="window.submitBookingForm(event)" class="p-6 space-y-3.5 text-xs">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="block font-bold text-slate-700 mb-1">Preferred Date</label><input id="apt-date" type="date" required value="${tomorrow}" class="${inputCls}" /></div>
          <div><label class="block font-bold text-slate-700 mb-1">Preferred Time</label>
            <select id="apt-time" class="${inputCls}"><option>10:30 AM</option><option>02:00 PM</option><option>04:30 PM</option></select></div>
        </div>
        <div><label class="block font-bold text-slate-700 mb-1">Hospital Facility</label><input id="apt-hospital" type="text" required class="${inputCls}" /></div>
        <div><label class="block font-bold text-slate-700 mb-1">Reason / Symptoms</label><textarea id="apt-reason" rows="3" class="${inputCls}"></textarea></div>
        ${footerBtns('Submit to Doctor', THEME[u.role].hex)}
      </form>`);
  }

  if (state.decision) {
    const approve = state.decision.action === 'approve';
    html += modalShell(approve ? '#059669' : '#E11D48', 'DOCTOR DECISION', approve ? 'Approve & Assign Slot' : 'Reject Appointment', `
      <div class="p-6 space-y-3.5 text-xs">
        ${approve ? `
          <div class="grid grid-cols-2 gap-2">
            <button onclick="window.selectPresetSlot('Today 02:30 PM - Bay 1')" class="p-2 border rounded-xl hover:bg-slate-50 text-left cursor-pointer">Today 02:30 PM</button>
            <button onclick="window.selectPresetSlot('Tomorrow 10:30 AM - Room 204')" class="p-2 border rounded-xl hover:bg-slate-50 text-left cursor-pointer">Tomorrow 10:30 AM</button>
          </div>
          <div><label class="block font-bold text-slate-700 mb-1">Confirmed Slot</label><input id="slot-input" type="text" value="Tomorrow 10:30 AM - Room 204" class="${inputCls}" /></div>` : ''}
        <div><label class="block font-bold text-slate-700 mb-1">Note to requester ${approve ? '(optional)' : '(reason)'}</label><textarea id="note-input" rows="2" class="${inputCls}"></textarea></div>
        <div class="flex justify-end gap-3 pt-3 border-t border-slate-100">
          <button onclick="window.closeModals()" class="px-4 py-2 font-bold text-slate-600 cursor-pointer">Cancel</button>
          <button onclick="window.confirmDecision()" class="px-5 py-2.5 text-white font-extrabold rounded-xl cursor-pointer" style="background:${approve ? '#059669' : '#E11D48'}">${approve ? 'Confirm Approval' : 'Confirm Rejection'}</button>
        </div>
      </div>`);
  }
  return html;
}

// =========================================================================
// 16. BOOTSTRAP
// =========================================================================
function bootstrap() {
  renderApp();
  initAuth();
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
}

export { connectFirebaseDatabase, state, renderApp };

# LifeDrop – workflow rebuilt from the flowchart

## Replace these files in your project
`app.js`, `index.html` (adds the Firebase **Auth** SDK script), and publish `firestore.rules`. `style.css` is unchanged.

## Firebase Console (one-time)
1. Build → Authentication → Sign-in method → enable **Email/Password**.
2. Build → Firestore Database → Rules → paste `firestore.rules` → Publish.
3. Register one account per role (Patient, Donor, Doctor) in the app to test.

## Flowchart → code
| Flowchart | Where |
|---|---|
| Login / Register, Choose ONE role, account details + blood group | `renderAuthPage`, `submitAuth` |
| Authenticate (Firebase Authentication) | `signInWithEmailAndPassword` / `createUserWithEmailAndPassword` |
| Role locked for session/account | role saved in `users/{uid}`; sign-in refuses a mismatched role; rules block role changes; no role switcher |
| Patient: view only matching donors → check compatibility → send request | `renderPatientDashboard`, `bloodGroupCanDonate`, `sendDonorRequest` |
| Donor accepts / rejects → DONOR FOUND, or back to list | `respondToOffer`, `matchedCard` |
| Donor: view only matching requests → accept / reject → patient accepts / rejects → PATIENT MATCHED | `renderDonorDashboard`, `acceptPatientRequest`, `rejectPatientRequest`, `respondToOffer` |
| Share contact/location securely | phone + location stored in `matches/{id}/contact/*`, readable only after status = Accepted |
| Side nav: Doctor Appointment | `renderAppointments` (patient and donor) |
| Doctor: review requests → Approve / Reject / Pending → requester sees status | `renderDoctorDashboard`, `confirmDecision`, `markPending` |
| End: session ended | `appLogout` |

## Firestore collections
`users`, `patientRequests`, `donors`, `matches` (+ `contact` subcollection), `appointments`.

## Removed because they are not in the flowchart
Groups page, home hero/action cards, the 1–5 "simulate dispatch" tracker, localStorage fallback, and the demo default user.

## Known gaps
- Anyone can register as a Doctor. Before real use, add a `verified` flag set by an admin and require it in the rules.
- A matched donor stays "Matched" (no cancel/complete step in the flowchart).
- Tested here with a mocked DOM only (all screens render, incompatible groups are filtered, user text is escaped). It has not been run against live Firebase.


## Admin dashboard and donation cooldown (added)
1. Create the admin account securely in Firebase Console → Authentication → Users → Add user. Do not use the public Register form for admin.
2. Copy that account's Authentication UID. In Firestore, create `users/{AUTH_UID}` with fields:
   - `role`: `admin`
   - `name`: `LifeDrop Admin`
   - `email`: the same email used in Firebase Authentication
   - `createdAt`: a Firestore timestamp
3. Publish the updated `firestore.rules` from this folder. The website shows **Admin Sign In Only** when Admin is selected; there is no Admin Register option. Sign in using that email/password.
4. The Admin Dashboard shows accepted donor–patient matches and donor records. Click **Confirm Blood Donated** only after donation is confirmed. This marks the match as recorded and updates the donor record (`lastDonationAt`, `cooldownUntil`, `lastDonationMatchId`, and `status: Unavailable`).
5. A recorded donor is blocked from patient matching for **90 days**. The donor dashboard shows a cooldown notice; trying to set availability to Available during that period is blocked. Firestore rules also block attempts to create a match with a donor who is unavailable or still in cooldown.
6. The cooldown is a conservative app workflow setting, not medical advice. A hospital/qualified clinician should determine actual donor eligibility and timing.


## Admin login-only behavior
- Admin is selectable only for sign-in; selecting Admin automatically switches to sign-in and hides the Register control.
- Patient, Donor, and Doctor keep the existing Register + Login options.
- Public registration code rejects `admin`; Firestore `users` creation rules only allow `patient`, `donor`, or `doctor`.
- Never grant admin role from client-side registration. Create the admin Authentication account manually and create `users/{AUTH_UID}` with `role: admin` in Firestore.

/* ====================================================================
   FIREBASE AUTH + VALIDATION + CONTACT FORM
   Logic ported intact from the original build (same Firestore
   collections, same validation rules, same gating behaviour for
   .requires-auth links). Only the literal CSS class strings the script
   injects at runtime have been updated to match this project's class
   names (hero-tab / has-error / btn-submit etc.) instead of the old
   Tailwind utility strings, since this rebuild does not ship Tailwind.
   ==================================================================== */

// ---- Phone input digit guard (independent of Firebase import) ----
document.addEventListener('DOMContentLoaded', () => {
  function restrictToDigits(inputEl, maxLen = 10) {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      const digitsOnly = inputEl.value.replace(/\D/g, '').slice(0, maxLen);
      if (digitsOnly !== inputEl.value) inputEl.value = digitsOnly;
    });
    inputEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData || window.clipboardData).getData('text');
      const digitsOnly = pasted.replace(/\D/g, '').slice(0, maxLen);
      inputEl.value = digitsOnly;
    });
  }
  restrictToDigits(document.getElementById('contact-phone'));
  restrictToDigits(document.getElementById('user-phone'));
  restrictToDigits(document.getElementById('hero-whatsapp'));
});

// ---- Firebase module ----
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-analytics.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOIDBbvA0zLmCCyxjWE7vi1TjQi7hDjh0",
  authDomain: "padhle-india.firebaseapp.com",
  projectId: "padhle-india",
  storageBucket: "padhle-india.firebasestorage.app",
  messagingSenderId: "420251652776",
  appId: "1:420251652776:web:3758004a37ef43f318a89d",
  measurementId: "G-K2MQCQCGST"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let userPhoneVerified = false;
let pendingAction = null;
let activeTargetClass = '10';
window.activeTargetClass = activeTargetClass;

const authModal = document.getElementById('auth-modal');
const googleSection = document.getElementById('google-login-section');
const phoneSection = document.getElementById('phone-section');
const googleBtn = document.getElementById('google-signin-btn');
const savePhoneBtn = document.getElementById('save-phone-btn');
const phoneInput = document.getElementById('user-phone');
const closeAuthBtn = document.getElementById('close-auth-btn');

const loginTcCheckbox = document.getElementById('login-tc-agree');
const contactTcCheckbox = document.getElementById('contact-tc-agree');
const tcCheckboxes = [loginTcCheckbox, contactTcCheckbox];

const openTcBtns = document.querySelectorAll('.open-tc-btn');
const tcPopup = document.getElementById('tc-popup');
const closeTcBtn = document.getElementById('close-tc-btn');
const acceptTcBtn = document.getElementById('accept-tc-btn');
const contactSubmitBtn = document.getElementById('contact-submit-btn');

let currentTcTarget = null;

function validateIndianPhone(phone) {
  const cleanPhone = phone.trim();
  if (!/^[6-9]\d{9}$/.test(cleanPhone)) return { valid: false, msg: "Please enter a valid 10-digit Mobile number." };
  if (/^(\d)\1{9}$/.test(cleanPhone) || ['1234567890', '0123456789', '9876543210'].includes(cleanPhone)) {
    return { valid: false, msg: "This appears to be a Test or Invalid number." };
  }
  return { valid: true };
}

function showPhoneError(inputEl, msg) {
  alert(msg);
  inputEl.classList.add('has-error', 'error-shake');
  setTimeout(() => inputEl.classList.remove('error-shake'), 500);
  inputEl.addEventListener('input', function fix() {
    inputEl.classList.remove('has-error');
    inputEl.removeEventListener('input', fix);
  });
}

// ---- Hero academic-goal tab selector ----
window.setTargetClass = function (classVal) {
  activeTargetClass = classVal;
  window.activeTargetClass = classVal;
  const tab10 = document.getElementById('tab-class-10');
  const tab9 = document.getElementById('tab-class-9');
  const tabOly = document.getElementById('tab-class-oly');
  [tab10, tab9, tabOly].forEach(tab => tab && tab.classList.remove('is-active'));

  const whatsappInput = document.getElementById('hero-whatsapp');
  if (classVal === '10') {
    if (tab10) tab10.classList.add('is-active');
    if (whatsappInput) whatsappInput.placeholder = "Enter WhatsApp Number for Class 10 Notes";
  } else if (classVal === '9') {
    if (tab9) tab9.classList.add('is-active');
    if (whatsappInput) whatsappInput.placeholder = "Enter WhatsApp Number for Class 9 Notes";
  } else {
    if (tabOly) tabOly.classList.add('is-active');
    if (whatsappInput) whatsappInput.placeholder = "Enter WhatsApp Number for Olympiad Sheets";
  }
};

// ---- Hero WhatsApp lead capture ----
const heroFormBtn = document.getElementById('hero-form-btn');
const heroWhatsappInput = document.getElementById('hero-whatsapp');

if (heroFormBtn && heroWhatsappInput) {
  heroFormBtn.addEventListener('click', async () => {
    const phoneVal = heroWhatsappInput.value;
    const validation = validateIndianPhone(phoneVal);
    if (!validation.valid) return showPhoneError(heroWhatsappInput, validation.msg);

    const processLead = async () => {
      const originalText = heroFormBtn.innerHTML;
      heroFormBtn.innerHTML = "Processing...";
      try {
        await addDoc(collection(db, "Leads_Onboarding"), {
          whatsapp: phoneVal,
          targetClass: activeTargetClass,
          source: "Hero_Onboarding_Widget",
          timestamp: new Date()
        });
        alert("Access Granted! Sending your notes package directly on WhatsApp.");
        heroWhatsappInput.value = "";
      } catch (error) {
        alert("Error securing resources. Please verify connection.");
      } finally {
        heroFormBtn.innerHTML = originalText;
      }
    };

    if (currentUser && userPhoneVerified) processLead();
    else showAuthModal(processLead);
  });
}

// ---- T&C checkbox -> enable/disable dependent buttons ----
if (loginTcCheckbox) {
  loginTcCheckbox.addEventListener('change', (e) => {
    if (googleBtn) googleBtn.disabled = !e.target.checked;
  });
}
if (contactTcCheckbox) {
  contactTcCheckbox.addEventListener('change', (e) => {
    if (contactSubmitBtn) contactSubmitBtn.disabled = !e.target.checked;
  });
}

// ---- T&C modal open/close/accept ----
openTcBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    currentTcTarget = e.target.closest('#auth-modal') ? loginTcCheckbox : contactTcCheckbox;
    if (tcPopup) tcPopup.classList.add('is-open');
  });
});
if (closeTcBtn) closeTcBtn.addEventListener('click', () => tcPopup && tcPopup.classList.remove('is-open'));
if (acceptTcBtn) {
  acceptTcBtn.addEventListener('click', () => {
    if (currentTcTarget) {
      currentTcTarget.checked = true;
      currentTcTarget.dispatchEvent(new Event('change'));
    } else {
      tcCheckboxes.forEach(cb => { if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); } });
    }
    if (tcPopup) tcPopup.classList.remove('is-open');
  });
}

// ---- Auth state listener ----
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    const userRef = doc(db, "Users", user.uid);
    try {
      const userSnap = await getDoc(userRef);
      if (userSnap.exists() && userSnap.data().phoneNumber) {
        userPhoneVerified = true;
        closeAuthModal();
        if (pendingAction) { pendingAction(); pendingAction = null; }
      } else {
        userPhoneVerified = false;
        if (authModal && authModal.classList.contains('is-open')) {
          if (googleSection) googleSection.classList.add('is-hidden');
          if (phoneSection) phoneSection.classList.remove('is-hidden');
        }
      }
    } catch (error) {
      console.error("Firestore Error: ", error);
    }
  } else {
    currentUser = null;
    userPhoneVerified = false;
  }
});

function showAuthModal(action) {
  pendingAction = action;
  if (authModal) authModal.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  if (currentUser && !userPhoneVerified) {
    if (googleSection) googleSection.classList.add('is-hidden');
    if (phoneSection) phoneSection.classList.remove('is-hidden');
  } else {
    if (googleSection) googleSection.classList.remove('is-hidden');
    if (phoneSection) phoneSection.classList.add('is-hidden');
  }
}

function closeAuthModal() {
  if (authModal) authModal.classList.remove('is-open');
  document.body.style.overflow = '';
  pendingAction = null;
  setTimeout(() => {
    if (googleSection) googleSection.classList.remove('is-hidden');
    if (phoneSection) phoneSection.classList.add('is-hidden');
    if (tcPopup) tcPopup.classList.remove('is-open');
  }, 300);
}
if (closeAuthBtn) closeAuthBtn.addEventListener('click', closeAuthModal);

if (googleBtn) {
  googleBtn.addEventListener('click', () => {
    if (!loginTcCheckbox.checked) {
      alert("Please agree to the Privacy Policy and T&C before continuing.");
      return;
    }
    signInWithPopup(auth, provider).catch(() => console.log("Login Cancelled or Failed"));
  });
}

if (savePhoneBtn) {
  savePhoneBtn.addEventListener('click', async () => {
    const phoneVal = phoneInput.value;
    const validation = validateIndianPhone(phoneVal);
    if (!validation.valid) return showPhoneError(phoneInput, validation.msg);

    if (currentUser) {
      const originalText = savePhoneBtn.innerText;
      savePhoneBtn.innerText = "Saving...";
      try {
        await setDoc(doc(db, "Users", currentUser.uid), {
          name: currentUser.displayName,
          email: currentUser.email,
          phoneNumber: phoneVal,
          joinedAt: new Date()
        }, { merge: true });
        userPhoneVerified = true;
        closeAuthModal();
        if (pendingAction) { pendingAction(); pendingAction = null; }
      } catch (error) {
        alert("Error saving number. Please check your Firestore rules.");
        savePhoneBtn.innerText = originalText;
      }
    }
  });
}

// ---- Gated resource links ----
document.querySelectorAll('.requires-auth').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const targetUrl = link.getAttribute('href');
    const action = () => window.open(targetUrl, '_blank');
    if (currentUser && userPhoneVerified) action();
    else showAuthModal(action);
  });
});

// ---- Contact form ----
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!contactTcCheckbox.checked) {
      alert("Please agree to the Privacy Policy and T&C.");
      return;
    }
    const phoneInputEl = document.getElementById('contact-phone');
    const phoneVal = phoneInputEl.value;
    const validation = validateIndianPhone(phoneVal);
    if (!validation.valid) return showPhoneError(phoneInputEl, validation.msg);

    const submitAction = async () => {
      const name = document.getElementById('contact-name').value;
      const email = document.getElementById('contact-email').value;
      const message = document.getElementById('contact-message').value;
      if (!name || !email || !message) return;

      const originalText = contactSubmitBtn.innerHTML;
      contactSubmitBtn.innerHTML = "Sending...";
      try {
        await addDoc(collection(db, "Contact_Messages"), {
          name, email, phone: phoneVal, message, timestamp: new Date()
        });
        alert("Message Sent Successfully! Team will connect with you soon.");
        contactForm.reset();
      } catch (error) {
        alert("Error sending message. Check Firebase Rules.");
      } finally {
        contactSubmitBtn.innerHTML = originalText;
      }
    };

    if (currentUser && userPhoneVerified) submitAction();
    else showAuthModal(submitAction);
  });
}

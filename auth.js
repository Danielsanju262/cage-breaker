import { auth } from './firebase-config.js';
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    GoogleAuthProvider, 
    signInWithPopup, 
    signOut as firebaseSignOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// State
export let currentUser = null;

// DOM Elements
const loginModal = document.getElementById('login-modal');
const modalOverlay = document.getElementById('modal-overlay');
const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const errorText = document.getElementById('login-error');
const btnEmailLogin = document.getElementById('btn-email-login');
const btnGoogleLogin = document.getElementById('btn-google-login');
const btnShowLogin = document.getElementById('btn-show-login');
const btnLogout = document.getElementById('btn-logout');
const btnCloseLogin = document.getElementById('btn-close-login');
const authUserInfo = document.getElementById('auth-user-info');
const authLoginPrompt = document.getElementById('auth-login-prompt');
const userEmailDisplay = document.getElementById('user-email');
const mainAppContent = document.getElementById('main-app-content');
const loadingState = document.getElementById('loading-state');

// Listeners
export function initAuth(onUserChangeCallback) {
    if (!auth) {
        loadingState.innerHTML = '<p style="color:#e74c3c;">Firebase not configured. Please add your config in firebase-config.js.</p>';
        return;
    }

    setPersistence(auth, browserLocalPersistence).catch(console.error);

    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        loadingState.style.display = 'none';
        
        const glassHeader = document.querySelector('.glass-header');

        if (user) {
            // Logged in — show user info, hide login prompt
            authUserInfo.style.display = 'flex';
            authLoginPrompt.style.display = 'none';
            userEmailDisplay.textContent = user.displayName || user.email;
            mainAppContent.style.display = 'block';
            if (glassHeader) glassHeader.style.display = 'flex';
            closeLoginModal();
        } else {
            // Logged out — show content as read-only, show login button
            authUserInfo.style.display = 'none';
            authLoginPrompt.style.display = 'flex';
            mainAppContent.style.display = 'block';
            if (glassHeader) glassHeader.style.display = 'flex';
        }
        
        if (onUserChangeCallback) onUserChangeCallback(user);
    });

    btnShowLogin.addEventListener('click', openLoginModal);
    btnCloseLogin.addEventListener('click', closeLoginModal);
    btnLogout.addEventListener('click', logout);
    btnEmailLogin.addEventListener('click', handleEmailLogin);
    btnGoogleLogin.addEventListener('click', handleGoogleLogin);
    
    const handleAuthOverlayClose = (e) => {
        if (e.target === modalOverlay && loginModal.classList.contains('active')) {
            closeLoginModal();
        }
    };
    modalOverlay.addEventListener('mousedown', handleAuthOverlayClose);
    modalOverlay.addEventListener('touchstart', handleAuthOverlayClose, {passive: true});

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && loginModal.classList.contains('active')) {
            closeLoginModal();
        }
    });

    const handleLoginEnter = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleEmailLogin();
        }
    };
    emailInput.addEventListener('keydown', handleLoginEnter);
    passwordInput.addEventListener('keydown', handleLoginEnter);
}

function openLoginModal() {
    modalOverlay.classList.add('active');
    loginModal.classList.add('active');
    errorText.style.display = 'none';
}

function closeLoginModal() {
    loginModal.classList.remove('active');
    emailInput.value = '';
    passwordInput.value = '';
    // Only remove overlay active if no other modal cards are still active
    const anyOtherActive = modalOverlay.querySelector('.modal-card.active');
    if (!anyOtherActive) {
        modalOverlay.classList.remove('active');
    }
}

async function handleEmailLogin() {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    
    if (!email || !password) {
        showError("Please enter email and password");
        return;
    }

    try {
        // Try login first
        await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        // If user not found, try to register them
        if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
            try {
                await createUserWithEmailAndPassword(auth, email, password);
            } catch (regError) {
                showError(regError.message);
            }
        } else {
            showError(error.message);
        }
    }
}

async function handleGoogleLogin() {
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        showError(error.message);
    }
}

async function logout() {
    try {
        await firebaseSignOut(auth);
    } catch (error) {
        console.error("Logout error", error);
    }
}

function showError(msg) {
    errorText.textContent = msg;
    errorText.style.display = 'block';
}

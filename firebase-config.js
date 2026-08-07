import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// TODO: Replace this with your actual Firebase project configuration
// 1. Go to Firebase Console (console.firebase.google.com)
// 2. Create a Project and add a Web App
// 3. Enable Authentication (Email/Password & Google)
// 4. Enable Firestore Database
// 5. Copy the config object below:

const firebaseConfig = {
  apiKey: "AIzaSyBUdeRzUnNIZLl5WmtM0npEenTFHUWbZXY",
  authDomain: "wedding-plan-16972.firebaseapp.com",
  projectId: "wedding-plan-16972",
  storageBucket: "wedding-plan-16972.firebasestorage.app",
  messagingSenderId: "258873353487",
  appId: "1:258873353487:web:66dda5e9deb7fbaceb4a7a",
  measurementId: "G-02H0194T7L"
};

let app, auth, db;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (error) {
    console.error("Firebase Initialization Error (Missing config?):", error);
}

export { app, auth, db };

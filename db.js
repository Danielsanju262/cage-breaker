import { db } from './firebase-config.js';
import { currentUser } from './auth.js';
import { 
    doc, 
    getDoc, 
    setDoc,
    updateDoc,
    deleteDoc, 
    onSnapshot,
    collection,
    addDoc,
    query,
    orderBy,
    limit,
    serverTimestamp,
    where
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const TIMELINE_ID = 'timeline_1';

let onTimelineUpdateCallback = null;
let onPresenceUpdateCallback = null;
let syncStatusEl = document.getElementById('sync-status');
let presenceInterval = null;

// Helper to show sync status
export function setSyncing(status) {
    if (!syncStatusEl) return;
    if (status === 'syncing') {
        syncStatusEl.innerHTML = '<span class="material-icons-round" style="font-size: 1rem; vertical-align: middle;">sync</span> Saving...';
        syncStatusEl.style.color = 'var(--text-muted)';
    } else if (status === 'saved') {
        syncStatusEl.innerHTML = '<span class="material-icons-round" style="font-size: 1rem; vertical-align: middle; color: #2ecc71;">check_circle</span> Saved to Drive';
        syncStatusEl.style.color = '#2ecc71';
        setTimeout(() => {
            syncStatusEl.innerHTML = '';
        }, 3000);
    } else {
        syncStatusEl.innerHTML = status;
        syncStatusEl.style.color = 'var(--text-muted)';
    }
}

let isDbInitialized = false;
let currentPresenceId = null;
let presenceEventListenersSetup = false;

export function initDB(onDataChange, onPresenceChange) {
    if (!db) return;
    onTimelineUpdateCallback = onDataChange;
    onPresenceUpdateCallback = onPresenceChange;

    if (!isDbInitialized) {
        isDbInitialized = true;

        // 1. Listen to Timeline Document (works for both anonymous and authenticated)
        const timelineRef = doc(db, 'timelines', TIMELINE_ID);
        onSnapshot(timelineRef, (docSnap) => {
            if (docSnap.exists()) {
                if (onTimelineUpdateCallback) {
                    onTimelineUpdateCallback(docSnap.data());
                }
            } else {
                // Document doesn't exist, initialize it (only if logged in)
                if (currentUser) {
                    initializeTimeline(timelineRef);
                } else if (onTimelineUpdateCallback) {
                    onTimelineUpdateCallback(getInitialFallbackState());
                }
            }
        }, (error) => {
            console.error("Error listening to timeline:", error);
            if (onTimelineUpdateCallback) {
                onTimelineUpdateCallback(getInitialFallbackState());
            }
        });

        // 2. Listen to Presence Collection (works for anonymous viewers too)
        const presenceRef = collection(db, 'timelines', TIMELINE_ID, 'presence');
        onSnapshot(presenceRef, (snapshot) => {
            const activeUsers = {};
            const now = Date.now();
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                // Filter out stale users (no heartbeat for 15s)
                if (data.lastActive && (now - data.lastActive) < 15000) {
                    activeUsers[docSnap.id] = data;
                } else if (data.lastActive) {
                    deleteDoc(docSnap.ref).catch(() => {});
                }
            });
            if (onPresenceUpdateCallback) {
                onPresenceUpdateCallback(activeUsers);
            }
        });

        setupPresenceEventListeners();
    }

    // Start presence heartbeat for both logged in & anonymous viewers
    startPresenceHeartbeat();
}

export function getInitialFallbackState() {
    return {
        _isFallback: true,
        owner: currentUser ? currentUser.uid : null,
        collaborators: {},
        title: 'Wedding Timeline',
        activeDayId: 'day1',
        days: [
            { id: 'day1', name: 'Thursday', date: '6th August', rawDate: '2026-08-06', order: 0 }
        ],
        events: [
            { id: 'ev1', dayId: 'day1', time: '08:00 AM', title: 'Breakfast', order: 0, collapsed: false }
        ],
        categories: [
            { id: 'cat1', eventId: 'ev1', title: 'Logistics', order: 0, collapsed: false }
        ],
        tasks: [
            { id: 'tsk1', categoryId: 'cat1', text: 'Pick up bagels', description: '', completed: false, order: 0 }
        ]
    };
}

async function initializeTimeline(ref) {
    if (!currentUser) return;
    const defaultState = getInitialFallbackState();
    delete defaultState._isFallback;
    try {
        await setDoc(ref, defaultState);
    } catch (e) {
        console.error("Error initializing document", e);
    }
}

/**
 * Syncs the state to Firestore (allowed for owners, editors, and queries from viewers).
 */
export async function syncState(newState) {
    if (!db || !newState) return;

    // CRITICAL DATA PROTECTION GUARD: Never write fallback/dummy state or empty state to Firestore
    if (newState._isFallback) {
        console.warn("syncState blocked: Attempted to write fallback/uninitialized state to Firestore.");
        return;
    }

    if (!Array.isArray(newState.days) || newState.days.length === 0) {
        console.warn("syncState blocked: Attempted to write invalid or empty days array to Firestore.");
        return;
    }

    setSyncing('syncing');
    try {
        const timelineRef = doc(db, 'timelines', TIMELINE_ID);
        const dataToSave = { ...newState };
        delete dataToSave._isFallback;
        await setDoc(timelineRef, dataToSave, { merge: true });
        setSyncing('saved');
    } catch (error) {
        console.error("Error syncing timeline:", error);
        setSyncing('<span style="color:#e74c3c;">Offline</span>');
    }
}

export async function updateAppVersionInDb(version) {
    if (!db) return;
    try {
        const timelineRef = doc(db, 'timelines', TIMELINE_ID);
        await updateDoc(timelineRef, { appVersion: version });
    } catch (e) {
        console.error("Error updating app version in DB:", e);
    }
}

// ---- PRESENCE SYSTEM (LOGGED-IN & ANONYMOUS VIEWERS) ----
let anonSessionId = null;
let anonName = null;

const GOOGLE_DOCS_ANIMALS = [
    'Alligator', 'Anteater', 'Armadillo', 'Aurochs', 'Axolotl', 'Badger', 'Bat', 'Bear', 
    'Buffalo', 'Camel', 'Capybara', 'Chameleon', 'Cheetah', 'Chinchilla', 'Cormorant', 'Coyote', 
    'Crow', 'Dingo', 'Dinosaur', 'Dolphin', 'Duck', 'Elephant', 'Falcon', 'Ferret', 'Flamingo', 
    'Fox', 'Frog', 'Gazelle', 'Giraffe', 'Gopher', 'Grizzly', 'Hamster', 'Hedgehog', 'Hippo', 
    'Hyena', 'Iguana', 'Jackal', 'Ibex', 'Kangaroo', 'Koala', 'Kraken', 'Lemur', 'Leopard', 
    'Llama', 'Manatee', 'Meerkat', 'Mink', 'Monkey', 'Moose', 'Narwhal', 'Octopus', 'Orangutan', 
    'Otter', 'Owl', 'Panda', 'Peacock', 'Penguin', 'Platypus', 'Puffin', 'Python', 'Quokka', 
    'Rabbit', 'Racoon', 'Rhino', 'Seal', 'Sheep', 'Skunk', 'Sloth', 'Squirrel', 'Tiger', 
    'Turtle', 'Walrus', 'Wolf', 'Wombat'
];

let cachedHighEntropyModel = null;

if (typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['model', 'platform'])
        .then(uaData => {
            if (uaData && uaData.model && uaData.model.trim() !== '') {
                cachedHighEntropyModel = uaData.model.trim();
                if (typeof updatePresence === 'function') {
                    try { updatePresence(); } catch(e) {}
                }
            }
        })
        .catch(() => {});
}

function getGpuModelName() {
    try {
        if (typeof document === 'undefined') return '';
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return '';
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (!debugInfo) return '';
        return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
    } catch (e) {
        return '';
    }
}

export function getDeviceName() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouch = navigator.maxTouchPoints || 0;
    const isTouch = maxTouch > 0 || 'ontouchstart' in window;
    const screenW = typeof window !== 'undefined' ? (window.screen ? window.screen.width : window.innerWidth) : 0;
    const screenH = typeof window !== 'undefined' ? (window.screen ? window.screen.height : window.innerHeight) : 0;

    // Check if high-entropy model is cached (e.g., Nothing Phone (2), Pixel 8, SM-S928B)
    if (cachedHighEntropyModel) {
        let name = cachedHighEntropyModel;
        if (/^A0\d+/i.test(name) || /^AIN\d+/i.test(name)) {
            name = 'Nothing Phone (' + name + ')';
        }
        return name;
    }

    // iPhone detection using WebGL GPU Chipset fingerprinting + Screen resolution mapping
    if (/iPhone|iPod/.test(ua)) {
        const gpu = getGpuModelName();
        const minDim = Math.min(screenW, screenH);
        const maxDim = Math.max(screenW, screenH);

        // Apple GPU Chipset identification
        let chipModel = '';
        if (/A18/i.test(gpu)) {
            if (maxDim >= 932) chipModel = 'iPhone 16 Pro Max / Plus';
            else chipModel = 'iPhone 16 / 16 Pro';
        } else if (/A17/i.test(gpu)) {
            if (maxDim >= 932) chipModel = 'iPhone 15 Pro Max';
            else chipModel = 'iPhone 15 Pro';
        } else if (/A16/i.test(gpu)) {
            if (maxDim >= 932) chipModel = 'iPhone 15 Plus / 14 Pro Max';
            else chipModel = 'iPhone 15 / 14 Pro';
        } else if (/A15/i.test(gpu)) {
            if (maxDim >= 926 || maxDim === 896) chipModel = 'iPhone 14 Plus / 13 Pro Max';
            else if (minDim === 375 && maxDim === 812) chipModel = 'iPhone 13 Mini';
            else chipModel = 'iPhone 13 / 14';
        } else if (/A14/i.test(gpu)) {
            if (maxDim >= 926) chipModel = 'iPhone 12 Pro Max';
            else if (minDim === 375 && maxDim === 812) chipModel = 'iPhone 12 Mini';
            else chipModel = 'iPhone 12 / 12 Pro';
        } else if (/A13/i.test(gpu)) {
            if (maxDim >= 896) chipModel = 'iPhone 11';
            else chipModel = 'iPhone 11 Pro';
        }

        if (chipModel) return chipModel;

        // Fallback screen heuristics if WebGL is unavailable
        if (minDim >= 430 && maxDim >= 932) return 'iPhone 15/16 Pro Max';
        if (minDim >= 393 && maxDim >= 852) return 'iPhone 14/15/16 Pro';
        if (minDim >= 390 && maxDim >= 844) return 'iPhone 13/14';
        if (minDim === 375 && maxDim === 812) return 'iPhone Mini/X';
        
        return 'iPhone';
    }

    if (/iPad/.test(ua) || (platform === 'MacIntel' && maxTouch > 1)) {
        return 'iPad';
    }

    // Android Model Extraction from User-Agent string
    if (/Android/.test(ua)) {
        const androidMatch = ua.match(/Android\s+[^;]+;\s*([^;\)]+?)\s*(?:Build|\))/i);
        if (androidMatch && androidMatch[1]) {
            let rawModel = androidMatch[1].trim();
            if (rawModel && !/Mobile|Tablet|Android|Linux|wv|k/i.test(rawModel)) {
                if (/^A0\d+/i.test(rawModel) || /^AIN\d+/i.test(rawModel) || /Nothing/i.test(rawModel)) {
                    return 'Nothing Phone';
                }
                return rawModel;
            }
        }
        return (/Mobile/.test(ua) || screenW <= 768) ? 'Android Phone' : 'Android Tablet';
    }

    if (/Macintosh|Mac OS X/.test(ua)) {
        return 'Mac';
    }
    if (/Windows/.test(ua)) {
        return 'Windows PC';
    }
    if (/Linux/.test(ua)) {
        return 'Linux PC';
    }

    return (isTouch && screenW <= 768) ? 'Mobile Phone' : 'Web Device';
}

function getAnonIdentity() {
    if (!anonSessionId) {
        anonSessionId = sessionStorage.getItem('anon_session_id');
        if (!anonSessionId) {
            anonSessionId = 'anon_' + Math.random().toString(36).substring(2, 9);
            sessionStorage.setItem('anon_session_id', anonSessionId);
        }
    }
    if (!anonName || anonName.startsWith('Anonymous Guest') || anonName.startsWith('Anonymous Visitor') || anonName.startsWith('Anonymous Explorer') || anonName.startsWith('Anonymous Planner') || anonName.startsWith('Anonymous Reader')) {
        anonName = sessionStorage.getItem('anon_session_name');
        if (!anonName || anonName.startsWith('Anonymous Guest') || anonName.startsWith('Anonymous Visitor') || anonName.startsWith('Anonymous Explorer') || anonName.startsWith('Anonymous Planner') || anonName.startsWith('Anonymous Reader')) {
            const randomAnimal = GOOGLE_DOCS_ANIMALS[Math.floor(Math.random() * GOOGLE_DOCS_ANIMALS.length)];
            anonName = `Anonymous ${randomAnimal}`;
            sessionStorage.setItem('anon_session_name', anonName);
        }
    }
    return { id: anonSessionId, name: anonName };
}

function setupPresenceEventListeners() {
    if (presenceEventListenersSetup) return;
    presenceEventListenersSetup = true;

    const handleStateChange = () => {
        updatePresence();
    };

    document.addEventListener('visibilitychange', handleStateChange);
    window.addEventListener('blur', handleStateChange);
    window.addEventListener('focus', handleStateChange);

    const handleUnload = () => {
        if (currentPresenceId && db) {
            const presenceRef = doc(db, 'timelines', TIMELINE_ID, 'presence', currentPresenceId);
            deleteDoc(presenceRef).catch(() => {});
        }
    };

    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
}

export function updatePresence(forcedAwayState) {
    if (!db) return;

    const isAway = (typeof forcedAwayState === 'boolean')
        ? forcedAwayState
        : (document.visibilityState === 'hidden' || !document.hasFocus());

    const targetId = currentUser ? currentUser.uid : getAnonIdentity().id;

    // Clean up old identity doc if user logged in or logged out
    if (currentPresenceId && currentPresenceId !== targetId) {
        removePresenceUser(currentPresenceId);
    }
    currentPresenceId = targetId;

    const deviceName = getDeviceName();

    const presenceData = currentUser ? {
        email: currentUser.displayName || currentUser.email,
        displayName: currentUser.displayName || currentUser.email.split('@')[0],
        photoURL: currentUser.photoURL || null,
        isAnonymous: false,
        isAway: isAway,
        lastActive: Date.now(),
        color: getUserColor(currentUser.uid),
        device: deviceName
    } : {
        email: getAnonIdentity().name,
        displayName: getAnonIdentity().name,
        photoURL: null,
        isAnonymous: true,
        isAway: isAway,
        lastActive: Date.now(),
        color: getUserColor(getAnonIdentity().id),
        device: deviceName
    };

    const presenceRef = doc(db, 'timelines', TIMELINE_ID, 'presence', currentPresenceId);
    setDoc(presenceRef, presenceData, { merge: true }).catch(console.error);
}

function startPresenceHeartbeat() {
    if (presenceInterval) clearInterval(presenceInterval);
    updatePresence();
    presenceInterval = setInterval(() => {
        updatePresence();
    }, 5000); // 5 seconds heartbeat
}

export async function removePresenceUser(userId) {
    if (!db || !userId) return;
    try {
        const presenceRef = doc(db, 'timelines', TIMELINE_ID, 'presence', userId);
        await deleteDoc(presenceRef);
    } catch(e) {
        console.error("Error removing presence user:", e);
    }
}

// Generate a consistent color based on UID
export function getUserColor(uid) {
    let hash = 0;
    for (let i = 0; i < uid.length; i++) {
        hash = uid.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
}

// ---- ACCESS CONTROL API ----
export async function requestAccess() {
    if (!db || !currentUser) return;
    const reqRef = collection(db, 'requests');
    try {
        await addDoc(reqRef, {
            userId: currentUser.uid,
            email: currentUser.email,
            timelineId: TIMELINE_ID,
            status: 'pending',
            timestamp: serverTimestamp()
        });
        return true;
    } catch(e) {
        console.error("Error requesting access", e);
        return false;
    }
}

/**
 * Listen to the current user's own pending request for this timeline.
 * Used to show "Request Sent" state in the UI.
 */
export function listenToOwnRequest(callback) {
    if (!db || !currentUser) return;
    const reqRef = collection(db, 'requests');
    const q = query(
        reqRef,
        where('timelineId', '==', TIMELINE_ID),
        where('userId', '==', currentUser.uid),
        where('status', '==', 'pending')
    );
    
    onSnapshot(q, (snapshot) => {
        const hasPending = !snapshot.empty;
        callback(hasPending);
    }, (err) => {
        console.error("Error listening to own request", err);
    });
}

export function listenToAccessRequests(callback) {
    if (!db || !currentUser) return;
    const reqRef = collection(db, 'requests');
    const q = query(reqRef, where('timelineId', '==', TIMELINE_ID), where('status', '==', 'pending'));
    
    onSnapshot(q, (snapshot) => {
        const requests = [];
        snapshot.forEach((doc) => {
            requests.push({ id: doc.id, ...doc.data() });
        });
        callback(requests);
    }, (err) => {
        console.error("Error listening to requests", err);
    });
}

export async function deleteRequest(requestId) {
    if (!db || !currentUser) return;
    try {
        await deleteDoc(doc(db, 'requests', requestId));
    } catch(e) {
        console.error("Error deleting request", e);
    }
}


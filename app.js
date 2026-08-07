import { initAuth, currentUser } from './auth.js';
import { initDB, syncState, updatePresence, removePresenceUser, requestAccess, listenToAccessRequests, listenToOwnRequest, deleteRequest, getDeviceName, updateAppVersionInDb } from './db.js';

let state = null; 
let activeUsersData = {};
let syncTimeout = null;
let permissionLevel = 'read'; // 'owner', 'edit', 'read' — default is read for anonymous viewers
let deferredInstallPrompt = null;

const app = {
    deleteTarget: null,
    pendingRequests: [],
    listeningToRequests: false,
    listeningToOwnRequest: false,
    hasRequestedAccess: false,
    hasInitializedDay: false,
    hasScrolledToActive: false,
    
    init() {
        this.cacheDOM();
        
        // Lock screen orientation to portrait if supported
        if (window.screen && window.screen.orientation && window.screen.orientation.lock) {
            window.screen.orientation.lock('portrait').catch(() => {});
        }
        
        // Initialize DB immediately for anonymous read access
        initDB(
            this.onRemoteStateUpdate.bind(this), 
            this.onPresenceUpdate.bind(this)
        );

        // Safe loading guard: Log if database load takes longer than usual without injecting dummy data
        setTimeout(() => {
            if (!state) {
                console.log("Database response taking longer than usual... waiting for remote snapshot.");
            }
        }, 4000);
        
        initAuth((user) => {
            // Re-evaluate permissions when auth state changes
            if (state) {
                this.onRemoteStateUpdate(state);
            }
            updatePresence();
        });

        document.getElementById('btn-share').addEventListener('click', () => {
            app.openShareModal();
        });

        document.getElementById('btn-request-access').addEventListener('click', () => {
            app.handleRequestAccess();
        });

        document.getElementById('btn-add-collaborator').addEventListener('click', () => {
            app.addCollaborator();
        });
        
        // Modals
        document.querySelectorAll('.modal-cancel').forEach(btn => {
            btn.addEventListener('click', () => this.closeModal());
        });

        // Handle visual viewport for mobile keyboards cleanly
        if (window.visualViewport) {
            this.adjustModalForKeyboard = () => {
                if (this.modalOverlay && this.modalOverlay.classList.contains('active')) {
                    const vv = window.visualViewport;
                    const activeModal = this.modalOverlay.querySelector('.modal-card.active');
                    const isKeyboardOpen = vv.height < window.innerHeight * 0.88;

                    if (isKeyboardOpen) {
                        this.modalOverlay.classList.add('keyboard-open');
                        this.modalOverlay.style.top = `${vv.offsetTop}px`;
                        this.modalOverlay.style.height = `${vv.height}px`;
                        this.modalOverlay.style.flexDirection = 'column';
                        this.modalOverlay.style.alignItems = 'center';
                        this.modalOverlay.style.justifyContent = 'flex-end';
                        this.modalOverlay.style.paddingBottom = '10px';
                        
                        if (activeModal) {
                            activeModal.style.maxHeight = `${Math.min(vv.height - 20, window.innerHeight * 0.85)}px`;
                        }
                    } else {
                        this.modalOverlay.classList.remove('keyboard-open');
                        this.modalOverlay.style.top = '0px';
                        this.modalOverlay.style.height = '100%';
                        this.modalOverlay.style.flexDirection = '';
                        this.modalOverlay.style.alignItems = 'center';
                        this.modalOverlay.style.justifyContent = 'center';
                        this.modalOverlay.style.paddingBottom = '';
                        if (activeModal) {
                            activeModal.style.maxHeight = '85dvh';
                        }
                    }
                }
            };
            window.visualViewport.addEventListener('resize', this.adjustModalForKeyboard);
            window.visualViewport.addEventListener('scroll', this.adjustModalForKeyboard);

            // Gently scroll focused input/textarea into view inside modal card when keyboard opens
            document.addEventListener('focusin', (e) => {
                const target = e.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                    const activeModal = target.closest('.modal-card');
                    if (activeModal && activeModal.classList.contains('active')) {
                        setTimeout(() => {
                            this.adjustModalForKeyboard();
                            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }, 120);
                    }
                }
            });
        }

        // Mobile back gesture and back button step-by-step history handler
        window.addEventListener('popstate', (e) => {
            if (this._isPoppingState) {
                this._isPoppingState = false;
                return;
            }

            this._isPoppingState = true;

            // 1. Handle Modal closing if modal stack has open modals
            if (this.modalStack && this.modalStack.length > 0) {
                this.closeModal(true);
                setTimeout(() => { this._isPoppingState = false; }, 100);
                return;
            }

            // 2. Handle Day Tab history navigation if present
            if (e.state && e.state.dayId && state.activeDayId !== e.state.dayId) {
                this.setActiveDay(e.state.dayId, true);
            }

            setTimeout(() => { this._isPoppingState = false; }, 100);
        });

        if (this.modalOverlay) {
            const closeOnOutsideClick = (e) => {
                // Differentiate intentional backdrop taps from swipe gestures (only trigger if overlay itself was clicked)
                if (e.target !== this.modalOverlay) return;

                const activeModal = this.modalOverlay.querySelector('.modal-card.active');
                if (!activeModal) return;

                e.preventDefault();
                e.stopPropagation();
                
                // If an input/textarea is focused, blur it first to hide keyboard cleanly
                const activeEl = document.activeElement;
                if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
                    activeEl.blur();
                    return;
                }

                this.closeModal();
            };

            this.modalOverlay.addEventListener('click', closeOnOutsideClick);
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.modalStack && this.modalStack.length > 0) {
                    this.closeModal();
                }
            }
        });

        // Handle enter key in modal inputs to trigger save
        const bindEnterToSave = (inputId, saveFunc) => {
            const inputEl = document.getElementById(inputId);
            if (inputEl) {
                inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        saveFunc();
                    }
                });
            }
        };

        bindEnterToSave('new-day-date', () => this.saveDay());
        bindEnterToSave('new-event-title', () => this.saveEvent());
        bindEnterToSave('share-email', () => this.addCollaborator());
        bindEnterToSave('add-q-text', () => this.saveEventQuestion());
        bindEnterToSave('qs-input-text', () => this.submitQuestionFromSpace());

        // Custom Enter behavior for Task Modal Headline (moves focus to description box instead of saving directly)
        const taskModalTitle = document.getElementById('task-modal-title');
        if (taskModalTitle) {
            taskModalTitle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        this.saveTaskFromModal();
                    } else {
                        e.preventDefault();
                        const descInput = document.getElementById('task-modal-desc');
                        if (descInput) {
                            descInput.focus();
                        }
                    }
                }
            });
        }

        const taskModalDesc = document.getElementById('task-modal-desc');
        if (taskModalDesc) {
            taskModalDesc.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.saveTaskFromModal();
                }
            });
        }

        // Global focusout handler to trigger deferred renders cleanly after user finishes editing
        document.addEventListener('focusout', () => {
            if (this._pendingRenderAfterBlur) {
                setTimeout(() => {
                    const activeEl = document.activeElement;
                    const stillEditing = !!(activeEl && (
                        activeEl.tagName === 'INPUT' ||
                        activeEl.tagName === 'TEXTAREA' ||
                        activeEl.isContentEditable ||
                        window.currentFocusedField
                    ));
                    if (!stillEditing && this._pendingRenderAfterBlur) {
                        this._pendingRenderAfterBlur = false;
                        this.renderPreservingFocusAndScroll();
                    }
                }, 60);
            }
        });

        // Auto-resize for textareas
        document.addEventListener('input', (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('auto-resize')) {
                this.resizeTextarea(e.target);
            }
        });

        // PWA Install prompt
        this.initInstallPrompt();
    },

    initInstallPrompt() {
        const btnInstall = document.getElementById('btn-install-app');
        if (!btnInstall) return;

        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
            btnInstall.style.display = 'inline-flex';
        });

        btnInstall.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            const { outcome } = await deferredInstallPrompt.userChoice;
            if (outcome === 'accepted') {
                btnInstall.style.display = 'none';
            }
            deferredInstallPrompt = null;
        });

        // Hide install button if already installed
        window.addEventListener('appinstalled', () => {
            btnInstall.style.display = 'none';
            deferredInstallPrompt = null;
        });
    },

    cacheDOM() {
        this.titleInput = document.getElementById('app-title-input');
        this.tabsContainer = document.getElementById('day-tabs-container');
        this.eventsList = document.getElementById('events-list');
        this.modalOverlay = document.getElementById('modal-overlay');
        this.activeUsersContainer = document.getElementById('active-users');
    },

    getDefaultFallbackState() {
        return {
            _isFallback: true,
            owner: null,
            collaborators: {},
            title: 'Wedding Timeline',
            activeDayId: 'day1',
            days: [
                { id: 'day1', name: 'Thursday', date: '6th August', rawDate: '2026-08-06', order: 0 }
            ],
            events: [
                { id: 'ev1', dayId: 'day1', title: 'Breakfast', order: 0, collapsed: false }
            ],
            categories: [
                { id: 'cat1', eventId: 'ev1', title: 'Logistics', order: 0, collapsed: false }
            ],
            tasks: [
                { id: 'tsk1', categoryId: 'cat1', text: 'Pick up bagels', description: '', completed: false, order: 0 }
            ],
            questions: []
        };
    },

    // ==== SYNC HANDLERS ====
    triggerDebouncedSync() {
        if (permissionLevel === 'read') return;
        if (this._debouncedSyncTimer) {
            clearTimeout(this._debouncedSyncTimer);
        }
        this._debouncedSyncTimer = setTimeout(() => {
            if (state && !state._isFallback) {
                syncState(state);
            }
        }, 1000);
    },

    onRemoteStateUpdate(newState) {
        if (!newState) return;

        // Ensure arrays exist on state object to prevent any missing property crashes
        newState.days = newState.days || [];
        this.sortDays(newState.days);
        newState.events = newState.events || [];
        newState.categories = newState.categories || [];
        newState.tasks = newState.tasks || [];
        newState.questions = newState.questions || [];

        // Auto-reload open client tabs if a newer build version is deployed in Firestore
        const CURRENT_APP_VERSION = 43;
        if (newState.appVersion && newState.appVersion > CURRENT_APP_VERSION) {
            console.log(`New build version v${newState.appVersion} detected! Reloading app...`);
            window.location.reload(true);
            return;
        }

        // Check if user is actively typing / focused in an input or contenteditable element right now
        const activeEl = document.activeElement;
        const isEditing = !!(activeEl && (
            activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable ||
            window.currentFocusedField
        ));

        // Preserve local focused element's state if user is mid-typing
        const focusedId = window.currentFocusedField || (activeEl ? activeEl.id : null);
        
        if (state && focusedId && activeEl) {
            if (focusedId === 'app-title-input') {
                newState.title = activeEl.value || newState.title || state.title;
            } else if (focusedId.startsWith('event-title-')) {
                const evId = focusedId.replace('event-title-', '');
                const localEv = state.events.find(e => e.id === evId);
                const remoteEv = newState.events.find(e => e.id === evId);
                if (remoteEv) {
                    remoteEv.title = activeEl.innerText || (localEv ? localEv.title : remoteEv.title);
                }
            } else if (focusedId.startsWith('cat-title-')) {
                const catId = focusedId.replace('cat-title-', '');
                const localCat = state.categories.find(c => c.id === catId);
                const remoteCat = newState.categories.find(c => c.id === catId);
                if (remoteCat) {
                    remoteCat.title = activeEl.innerText || (localCat ? localCat.title : remoteCat.title);
                }
            } else if (focusedId.startsWith('task-text-')) {
                const taskId = focusedId.replace('task-text-', '');
                const localTask = state.tasks.find(t => t.id === taskId);
                const remoteTask = newState.tasks.find(t => t.id === taskId);
                if (remoteTask) {
                    remoteTask.text = activeEl.innerText || (localTask ? localTask.text : remoteTask.text);
                }
            }
        }

        state = newState;

        // Targeted version update: Only update appVersion field in Firestore without resending state
        if ((permissionLevel === 'owner' || permissionLevel === 'edit') && !state._isFallback) {
            if (!state.appVersion || state.appVersion < CURRENT_APP_VERSION) {
                state.appVersion = CURRENT_APP_VERSION;
                updateAppVersionInDb(CURRENT_APP_VERSION);
            }
        }

        // Determine permissions
        if (currentUser) {
            if (state.owner === currentUser.uid) {
                permissionLevel = 'owner';
                if (!app.listeningToRequests) {
                    app.listeningToRequests = true;
                    listenToAccessRequests(app.onRequestUpdate.bind(app));
                }
            } else if (state.collaborators && state.collaborators[currentUser.email] === 'edit') {
                permissionLevel = 'edit';
            } else if (state.collaborators && state.collaborators[currentUser.email] === 'read') {
                permissionLevel = 'read';
            } else {
                // Logged in but not a collaborator — still read-only (public view)
                permissionLevel = 'read';
            }
            // Start listening to own pending request for viewers
            if (permissionLevel === 'read' && !app.listeningToOwnRequest) {
                app.listeningToOwnRequest = true;
                listenToOwnRequest(app.onOwnRequestUpdate.bind(app));
            }
        } else {
            // Anonymous — read-only
            permissionLevel = 'read';
        }

        this.applyPermissionUI();

        // Active Day Tab Stability: Keep the user's currently selected tab if it exists
        if (this.userSelectedDayId && state.days.some(d => d.id === this.userSelectedDayId)) {
            state.activeDayId = this.userSelectedDayId;
        } else if (!app.hasInitializedDay && state.days.length > 0) {
            app.hasInitializedDay = true;
            
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const todayStr = `${yyyy}-${mm}-${dd}`; 
            
            let bestDayId = null;
            const todayDay = state.days.find(d => d.rawDate === todayStr);
            const todayEvents = todayDay ? (state.events || []).filter(e => e.dayId === todayDay.id) : [];
            const todayHasTimeline = todayEvents.length > 0;
            
            if (todayDay && todayHasTimeline) {
                // If today has a timeline, default to current date
                bestDayId = todayDay.id;
            } else {
                // Default to Monday 10th August (main event day)
                const mainEventDay = state.days.find(d => {
                    if (!d) return false;
                    if (d.rawDate === '2026-08-10') return true;
                    if (d.date && (d.date.includes('10th August') || d.date.includes('10 August'))) return true;
                    if (d.rawDate && d.rawDate.endsWith('-08-10')) return true;
                    return false;
                });
                
                if (mainEventDay) {
                    bestDayId = mainEventDay.id;
                } else {
                    bestDayId = state.days[0].id;
                }
            }
            state.activeDayId = bestDayId;
            this.userSelectedDayId = bestDayId;
        } else if (state.days.length > 0 && (!state.activeDayId || !state.days.some(d => d.id === state.activeDayId))) {
            state.activeDayId = state.days[0].id;
            this.userSelectedDayId = state.days[0].id;
        }
        
        // Defer full DOM re-rendering while user is actively typing in an input field
        if (isEditing) {
            this._pendingRenderAfterBlur = true;
            return;
        }

        // Render UI live in real-time preserving focus and scroll positions
        this.renderPreservingFocusAndScroll();
    },

    applyPermissionUI() {
        document.getElementById('main-app-content').style.display = 'block';

        // Share button logic — visible for owner and editors
        const btnShare = document.getElementById('btn-share');
        if (btnShare) {
            btnShare.style.display = (permissionLevel === 'owner' || permissionLevel === 'edit') ? 'inline-flex' : 'none';
        }

        // Request Access button — visible for logged-in viewers only
        const btnRequestAccess = document.getElementById('btn-request-access');
        if (btnRequestAccess) {
            const showRequest = currentUser && permissionLevel === 'read';
            btnRequestAccess.style.display = showRequest ? 'inline-flex' : 'none';
            
            if (showRequest && this.hasRequestedAccess) {
                btnRequestAccess.disabled = true;
                btnRequestAccess.classList.add('sent');
                document.getElementById('request-access-text').textContent = 'Request Sent';
                btnRequestAccess.querySelector('.material-icons-round').textContent = 'check';
            } else if (showRequest) {
                btnRequestAccess.disabled = false;
                btnRequestAccess.classList.remove('sent');
                document.getElementById('request-access-text').textContent = 'Request Access';
                btnRequestAccess.querySelector('.material-icons-round').textContent = 'lock_open';
            }
        }

        // Hide edit controls for read-only
        const isRead = permissionLevel === 'read';
        document.querySelectorAll('.delete-icon, .add-day-container, .add-event-container, .inline-input-container').forEach(el => {
            el.style.display = isRead ? 'none' : '';
        });
        
        // Disable title inputs if read only
        document.querySelectorAll('.editable-title, .day-title-input, .custom-input').forEach(el => {
            el.readOnly = isRead;
        });
    },

    checkIfBlocked() {
        if (!state || !state.blockedViewers) return false;
        const currentId = currentUser ? currentUser.uid : sessionStorage.getItem('anon_session_id');
        const currentEmail = currentUser ? currentUser.email : null;

        if ((currentId && state.blockedViewers[currentId]) || (currentEmail && state.blockedViewers[currentEmail])) {
            this.showBlockedOverlay();
            return true;
        }
        return false;
    },

    showBlockedOverlay() {
        let blockedEl = document.getElementById('blocked-access-overlay');
        if (!blockedEl) {
            blockedEl = document.createElement('div');
            blockedEl.id = 'blocked-access-overlay';
            blockedEl.style.cssText = 'position: fixed; inset: 0; background: rgba(18, 18, 22, 0.97); backdrop-filter: blur(14px); z-index: 999999; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; text-align: center; color: var(--text-main);';
            blockedEl.innerHTML = `
                <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(231, 76, 60, 0.15); border: 2px solid rgba(231, 76, 60, 0.4); display: flex; align-items: center; justify-content: center; margin-bottom: 1.25rem;">
                    <span class="material-icons-round" style="font-size: 2.2rem; color: #e74c3c;">block</span>
                </div>
                <h2 style="margin: 0 0 0.5rem 0; font-size: 1.4rem; font-weight: 700; color: #e74c3c;">Access Revoked</h2>
                <p style="margin: 0 0 1.5rem 0; max-width: 360px; font-size: 0.9rem; color: var(--text-muted); line-height: 1.55;">Your viewing session has been ended by the timeline owner. You can no longer view or access this wedding timeline.</p>
                <button onclick="window.location.reload()" class="btn-ghost" style="padding: 0.55rem 1.35rem; font-size: 0.85rem; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;">Try Reloading</button>
            `;
            document.body.appendChild(blockedEl);
        } else {
            blockedEl.style.display = 'flex';
        }
    },

    onPresenceUpdate(activeUsers) {
        if (this.checkIfBlocked()) return;
        activeUsersData = activeUsers;
        if (!this.activeUsersContainer) return;

        const currentId = currentUser ? currentUser.uid : sessionStorage.getItem('anon_session_id');
        const entries = Object.entries(activeUsers);
        
        if (entries.length === 0) {
            this.activeUsersContainer.innerHTML = '';
            return;
        }

        const usersArr = entries.map(([id, u]) => ({
            ...u,
            id,
            isSelf: id === currentId
        }));

        // Sort so "You" comes first, then logged-in users, then anonymous guests
        usersArr.sort((a, b) => {
            if (a.isSelf) return -1;
            if (b.isSelf) return 1;
            if (!a.isAnonymous && b.isAnonymous) return -1;
            if (a.isAnonymous && !b.isAnonymous) return 1;
            return 0;
        });

        const avatarsHTML = usersArr.map(u => {
            const hasPhoto = u.photoURL;
            const name = u.displayName || u.email || 'Guest Viewer';
            const statusText = u.isAway ? 'Away' : 'Active';
            const dev = u.device || (u.isSelf ? getDeviceName() : '');
            const deviceStr = dev ? ` (${dev})` : '';
            const displayTitle = u.isSelf ? `You (${name})${deviceStr} • ${statusText}` : `${name}${deviceStr} • ${statusText}`;
            const awayClass = u.isAway ? 'is-away' : '';
            const borderColor = u.isAway ? 'rgba(149, 165, 166, 0.6)' : (u.isSelf ? '#2ecc71' : (u.color || '#f39c12'));

            if (hasPhoto) {
                return `
                    <div class="user-avatar ${awayClass}" style="cursor: pointer; padding: 0; overflow: hidden; border: 2px solid ${borderColor}; position: relative;" title="${displayTitle}" onclick="app.showUserInfo('${u.id}')">
                        <img src="${u.photoURL}" alt="${name}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" referrerpolicy="no-referrer">
                    </div>
                `;
            } else if (u.isAnonymous) {
                return `
                    <div class="user-avatar ${awayClass}" style="background-color: ${u.color || '#e67e22'}; cursor: pointer; border: 2px solid ${borderColor}; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden;" title="${displayTitle}" onclick="app.showUserInfo('${u.id}')">
                        <span class="material-icons-round" style="font-size: 0.85rem; color: #fff;">visibility</span>
                    </div>
                `;
            } else {
                const initial = u.displayName ? u.displayName.charAt(0).toUpperCase() : (u.email ? u.email.charAt(0).toUpperCase() : '?');
                return `
                    <div class="user-avatar ${awayClass}" style="background-color: ${u.color || '#3498db'}; cursor: pointer; border: 2px solid ${borderColor}; position: relative; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; overflow: hidden;" title="${displayTitle}" onclick="app.showUserInfo('${u.id}')">
                        ${initial}
                    </div>
                `;
            }
        }).join('');

        this.activeUsersContainer.innerHTML = `
            <div style="display: flex; align-items: center; margin-left: 0.1rem;">
                ${avatarsHTML}
            </div>
        `;
    },

    selectedViewerUserId: null,

    showUserInfo(userId) {
        let u = activeUsersData[userId];
        if (!u) {
            u = Object.values(activeUsersData).find(x => x.email === userId || x.displayName === userId);
        }
        if (!u) return;

        this.selectedViewerUserId = u.id || userId;
        
        const nameEl = document.getElementById('user-info-name');
        const deviceEl = document.getElementById('user-info-device');
        const avatarEl = document.getElementById('user-info-avatar');
        const roleEl = document.getElementById('user-info-role');
        const removeBtn = document.getElementById('user-info-remove-btn');
        
        const isOwnerUser = state && state.owner && (u.id === state.owner || u.email === state.owner);
        const name = u.displayName || u.email || 'Guest Viewer';
        
        if (nameEl) nameEl.textContent = name;

        if (deviceEl) {
            const devName = u.device || (u.isSelf ? getDeviceName() : null);
            if (devName) {
                deviceEl.textContent = `(${devName})`;
                deviceEl.style.display = 'block';
                deviceEl.style.fontWeight = '600';
                deviceEl.style.color = 'var(--primary)';
            } else {
                deviceEl.style.display = 'none';
            }
        }
        
        if (roleEl) {
            const statusLabel = u.isAway ? 'Away (Tab Inactive)' : 'Active (Viewing Site)';
            if (isOwnerUser) {
                roleEl.textContent = `Owner • ${statusLabel}`;
                roleEl.style.color = '#f39c12';
            } else if (u.isAnonymous) {
                roleEl.textContent = `Guest Viewer • ${statusLabel}`;
                roleEl.style.color = u.isAway ? 'var(--text-muted)' : '#2ecc71';
            } else {
                roleEl.textContent = `Logged-in Viewer • ${statusLabel}`;
                roleEl.style.color = u.isAway ? 'var(--text-muted)' : '#3498db';
            }
        }
        
        if (avatarEl) {
            const isAwayClass = u.isAway ? 'is-away' : '';
            if (u.photoURL) {
                avatarEl.innerHTML = `<img src="${u.photoURL}" alt="${name}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" referrerpolicy="no-referrer">`;
                avatarEl.style.backgroundColor = 'transparent';
            } else if (u.isAnonymous) {
                avatarEl.innerHTML = `<span class="material-icons-round" style="font-size: 2rem; color: #fff;">visibility</span>`;
                avatarEl.style.backgroundColor = u.color || '#e67e22';
            } else {
                avatarEl.innerHTML = name.charAt(0).toUpperCase();
                avatarEl.style.backgroundColor = u.color || '#3498db';
            }
            if (u.isAway) {
                avatarEl.style.filter = 'grayscale(85%) opacity(0.65)';
            } else {
                avatarEl.style.filter = 'none';
            }
        }

        if (removeBtn) {
            if (permissionLevel === 'owner' && !u.isSelf && !isOwnerUser) {
                removeBtn.style.display = 'inline-flex';
            } else {
                removeBtn.style.display = 'none';
            }
        }
        
        this.openModal('user-info-modal');
    },

    removeSelectedViewer() {
        if (permissionLevel !== 'owner' || !this.selectedViewerUserId) return;
        const userId = this.selectedViewerUserId;
        const u = activeUsersData[userId];
        const userName = u ? (u.displayName || u.email || 'this viewer') : 'this viewer';

        this.promptDelete('viewer', userId, null, `Are you sure you want to remove ${userName} from viewing this wedding planner?`);
    },

    // ==== STATE MUTATION (DECOUPLED) ====
    modifyStateSilent(mutatorFn) {
        if (!state || permissionLevel === 'read') return;
        mutatorFn();
    },

    modifyStateAndRender(actionDesc, mutatorFn) {
        if (!state || permissionLevel === 'read') return;
        mutatorFn();
        syncState(state);
        this.render();
    },

    modifyQueriesAndRender(actionDesc, mutatorFn) {
        if (!state) return;
        mutatorFn();
        this.render();
        this.renderQuestionSpace();
        syncState(state);
    },

    // ==== FOCUS TRACKING & AUTO-SAVE ====
    onFieldFocus(fieldId) {
        if (permissionLevel === 'read') return;
        window.currentFocusedField = fieldId;
    },

    onFieldBlur(actionDesc) {
        if (permissionLevel === 'read') return;
        if (this._debouncedSyncTimer) {
            clearTimeout(this._debouncedSyncTimer);
            this._debouncedSyncTimer = null;
        }
        window.currentFocusedField = null;
        // Sync state immediately on blur for any changes made while focused
        syncState(state);
    },

    // ==== TITLE LOGIC ====

    handleTitleInput(val) {
        this.modifyStateSilent(() => {
            state.title = val;
        });
        this.triggerDebouncedSync();
    },

    preventEnter(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.target.blur();
        }
    },

    // ==== EDIT LOGIC (SILENT + DEBOUNCED AUTO-SAVE) ====
    editEventTitle(id, newTitle) {
        this.modifyStateSilent(() => {
            const event = state.events.find(e => e.id === id);
            if (event) event.title = newTitle;
        });
        this.triggerDebouncedSync();
    },

    editCategoryTitle(id, newTitle) {
        this.modifyStateSilent(() => {
            const cat = state.categories.find(c => c.id === id);
            if (cat) cat.title = newTitle;
        });
        this.triggerDebouncedSync();
    },

    editTaskText(id, newText) {
        this.modifyStateSilent(() => {
            const task = state.tasks.find(t => t.id === id);
            if (task) task.text = newText;
        });
        this.triggerDebouncedSync();
    },

    // ==== SEARCH LOGIC ====
    searchQuery: '',
    searchFilterType: 'all',

    highlightMatch(text, query) {
        if (!query || !text) return text || '';
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedQuery})`, 'gi');
        return text.replace(regex, '<mark class="search-highlight">$1</mark>');
    },

    handleSearchInput(val) {
        this.searchQuery = val || '';
        const clearBtn = document.getElementById('btn-clear-search');
        if (clearBtn) {
            clearBtn.style.display = this.searchQuery.trim().length > 0 ? 'flex' : 'none';
        }
        this.render();
    },

    clearSearch() {
        this.searchQuery = '';
        const input = document.getElementById('app-search-input');
        if (input) input.value = '';
        const clearBtn = document.getElementById('btn-clear-search');
        if (clearBtn) clearBtn.style.display = 'none';
        this.render();
    },

    setSearchFilterType(type) {
        this.searchFilterType = type || 'all';
        document.querySelectorAll('.filter-type-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-type') === type);
        });
        this.render();
    },

    jumpToItem(dayId, eventId, categoryId = null, taskId = null) {
        this.searchQuery = '';
        const input = document.getElementById('app-search-input');
        if (input) input.value = '';
        const clearBtn = document.getElementById('btn-clear-search');
        if (clearBtn) clearBtn.style.display = 'none';

        this.setActiveDay(dayId);

        if (!this.localExpandedEvents) this.localExpandedEvents = {};
        if (!this.localExpandedCategories) this.localExpandedCategories = {};

        this.localExpandedEvents[eventId] = true;
        if (categoryId) {
            this.localExpandedCategories[categoryId] = true;
        }

        if (permissionLevel !== 'read' && state) {
            const ev = state.events.find(e => e.id === eventId);
            if (ev) ev.collapsed = false;
            if (categoryId) {
                const cat = state.categories.find(c => c.id === categoryId);
                if (cat) cat.collapsed = false;
            }
            syncState(state);
        }

        this.render();

        setTimeout(() => {
            let targetEl = null;
            if (taskId) {
                targetEl = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
            }
            if (!targetEl && categoryId) {
                targetEl = document.querySelector(`.category[data-category-id="${categoryId}"]`);
            }
            if (!targetEl && eventId) {
                targetEl = document.querySelector(`.event-block[data-event-id="${eventId}"]`);
            }

            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetEl.classList.add('jump-highlight');
                setTimeout(() => targetEl.classList.remove('jump-highlight'), 1800);
            }
        }, 120);
    },

    // ==== DAY/EVENT LOGIC ====
    setActiveDay(id, fromPopState = false) {
        this.userSelectedDayId = id;
        if (state.activeDayId === id) return;
        state.activeDayId = id;
        if (!fromPopState && !this._isPoppingState) {
            try {
                history.pushState({ dayId: id }, '');
            } catch (e) {}
        }
        this.render();
    },
    handleTabClick(id) {
        if (state.activeDayId !== id) {
            this.setActiveDay(id);
        } else if (permissionLevel !== 'read') {
            this.openDatePickerForDay(id);
        }
    },

    toggleEvent(eventId, eventObj) {
        if (eventObj && eventObj.target) {
            const tag = eventObj.target.tagName.toLowerCase();
            if (tag === 'input' || tag === 'button' || eventObj.target.closest('.btn-icon') || eventObj.target.closest('.drag-handle') || eventObj.target.closest('.delete-icon') || eventObj.target.isContentEditable) {
                return;
            }
        }
        
        const ev = state.events.find(e => e.id === eventId);
        if (!ev) return;

        if (!this.localExpandedEvents) this.localExpandedEvents = {};
        if (!this.localExpandedCategories) this.localExpandedCategories = {};
        
        const currentlyExpanded = this.localExpandedEvents[eventId] !== undefined
            ? this.localExpandedEvents[eventId]
            : (ev.collapsed === false);

        if (!currentlyExpanded) {
            // Opening this event: expand this event, collapse all other events & all categories
            state.events.forEach(e => {
                this.localExpandedEvents[e.id] = (e.id === eventId);
            });
            state.categories.forEach(c => {
                this.localExpandedCategories[c.id] = false;
            });
        } else {
            // Closing this event: collapse this event & its categories
            this.localExpandedEvents[eventId] = false;
            state.categories.forEach(c => {
                if (c.eventId === ev.id) this.localExpandedCategories[c.id] = false;
            });
        }

        if (permissionLevel !== 'read') {
            state.events.forEach(e => {
                e.collapsed = !this.localExpandedEvents[e.id];
            });
            state.categories.forEach(c => {
                c.collapsed = !this.localExpandedCategories[c.id];
            });
            syncState(state);
        }

        this.render();
    },

    toggleCategory(categoryId, eventObj) {
        if (eventObj && eventObj.target) {
            const tag = eventObj.target.tagName.toLowerCase();
            if (tag === 'input' || tag === 'button' || eventObj.target.closest('.btn-icon') || eventObj.target.closest('.drag-handle') || eventObj.target.closest('.delete-icon') || eventObj.target.isContentEditable) {
                return;
            }
        }
        
        const cat = state.categories.find(c => c.id === categoryId);
        if (!cat) return;

        if (!this.localExpandedEvents) this.localExpandedEvents = {};
        if (!this.localExpandedCategories) this.localExpandedCategories = {};

        const currentlyExpanded = this.localExpandedCategories[categoryId] !== undefined
            ? this.localExpandedCategories[categoryId]
            : (!cat.collapsed);
        
        if (!currentlyExpanded) {
            // Opening this category: expand this category, collapse all other categories everywhere (accordion mode)
            state.categories.forEach(c => {
                this.localExpandedCategories[c.id] = (c.id === categoryId);
            });
            // Ensure parent timeline event is expanded so categories container & task list are fully visible, and collapse other events
            state.events.forEach(e => {
                this.localExpandedEvents[e.id] = (e.id === cat.eventId);
            });
        } else {
            // Closing this category
            this.localExpandedCategories[categoryId] = false;
        }

        if (permissionLevel !== 'read') {
            state.events.forEach(e => {
                e.collapsed = !this.localExpandedEvents[e.id];
            });
            state.categories.forEach(c => {
                c.collapsed = !this.localExpandedCategories[c.id];
            });
            syncState(state);
        }

        this.render();
    },

    toggleTaskExpand(taskId, eventObj) {
        if (eventObj) eventObj.stopPropagation();
        if (!this.expandedTasks) this.expandedTasks = {};
        const isCurrentlyExpanded = this.expandedTasks[taskId] !== false;
        this.expandedTasks[taskId] = !isCurrentlyExpanded;
        this.render();
    },

    resizeTextarea(el) {
        if (!el || !el.classList.contains('auto-resize')) return;
        const prevHeight = el.style.height;
        el.style.height = 'auto';
        const newHeight = el.scrollHeight + 'px';
        if (prevHeight !== newHeight) {
            el.style.height = newHeight;
        } else {
            el.style.height = prevHeight;
        }
    },

    modalStack: [],

    openModal(modalId) {
        if (!this.modalStack) this.modalStack = [];

        // Hide previous active modal card so only 1 modal card is active & visible at any time
        if (this.modalStack.length > 0) {
            const previousId = this.modalStack[this.modalStack.length - 1];
            const previousModal = document.getElementById(previousId);
            if (previousModal) {
                previousModal.classList.remove('active');
            }
        }

        if (this.modalStack[this.modalStack.length - 1] !== modalId) {
            this.modalStack.push(modalId);
        }

        document.body.classList.add('modal-open');
        this.modalOverlay.classList.add('active');
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.add('active');
        if (this.adjustModalForKeyboard) this.adjustModalForKeyboard();
        
        // Push modal history state so mobile back gesture / back button closes the modal
        if (!this._isPoppingState) {
            try {
                history.pushState({ modalId: modalId }, '');
            } catch (e) {}
        }

        // Ensure textareas are resized when they become visible
        setTimeout(() => {
            if (modal) modal.querySelectorAll('textarea.auto-resize').forEach(ta => this.resizeTextarea(ta));
        }, 10);
    },

    async handleRequestAccess() {
        if (!currentUser || permissionLevel !== 'read') return;
        const btn = document.getElementById('btn-request-access');
        if (btn) {
            btn.disabled = true;
            document.getElementById('request-access-text').textContent = 'Sending...';
        }
        const success = await requestAccess();
        if (success) {
            this.hasRequestedAccess = true;
            this.applyPermissionUI();
        } else {
            // Reset on failure
            if (btn) {
                btn.disabled = false;
                document.getElementById('request-access-text').textContent = 'Request Access';
            }
        }
    },

    onOwnRequestUpdate(hasPending) {
        this.hasRequestedAccess = hasPending;
        this.applyPermissionUI();
    },

    openShareModal() {
        if (permissionLevel !== 'owner' && permissionLevel !== 'edit') return;
        this.renderShareList();
        this.renderRequestsList();
        
        // Show/hide "Add Collaborator" button text based on role
        const addCollabBtn = document.getElementById('btn-open-add-collab');
        if (addCollabBtn) {
            addCollabBtn.style.display = '';
        }
        
        this.openModal('share-modal');
    },

    renderShareList() {
        const list = document.getElementById('collaborators-list');
        if (!list) return;
        
        // Find the owner email from activeUsersData or show "Owner"
        let ownerLabel = 'You';
        if (permissionLevel !== 'owner') {
            ownerLabel = 'Owner';
        }
        
        let html = '';
        
        // Show owner row only if current user is the owner
        if (permissionLevel === 'owner') {
            html += `
                <li>
                    <span class="collab-email">You</span>
                    <span class="collab-owner-badge">Owner</span>
                </li>
            `;
        }
        
        if (state.collaborators) {
            Object.entries(state.collaborators).forEach(([email, role]) => {
                const badgeClass = role === 'edit' ? 'editor' : 'viewer';
                const badgeText = role === 'edit' ? 'Editor' : 'Viewer';
                const isCurrentUser = currentUser && email === currentUser.email;
                html += `
                    <li>
                        <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                            <span class="collab-email" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${isCurrentUser ? email + ' (you)' : email}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                            <span class="collab-role-badge ${badgeClass}">${badgeText}</span>
                            ${permissionLevel === 'owner' ? `
                            <button class="collab-remove" onclick="app.removeCollaborator('${email}')" title="Remove">
                                <span class="material-icons-round" style="font-size: 1.1rem;">close</span>
                            </button>
                            ` : ''}
                        </div>
                    </li>
                `;
            });
        }
        
        list.innerHTML = html;
    },
    
    onRequestUpdate(requests) {
        this.pendingRequests = requests;
        const badge = document.getElementById('share-badge');
        if (badge) {
            if (requests.length > 0) {
                badge.style.display = 'flex';
                badge.textContent = requests.length;
            } else {
                badge.style.display = 'none';
            }
        }
        
        // If share modal is open, re-render requests
        const shareModal = document.getElementById('share-modal');
        if (shareModal && shareModal.classList.contains('active')) {
            this.renderRequestsList();
        }
    },
    
    renderRequestsList() {
        const section = document.getElementById('pending-requests-section');
        const list = document.getElementById('requests-list');
        if (!section || !list) return;
        
        if (this.pendingRequests.length === 0 || permissionLevel !== 'owner') {
            section.style.display = 'none';
            return;
        }
        
        section.style.display = 'block';
        
        list.innerHTML = this.pendingRequests.map(req => `
            <li>
                <div style="display: flex; align-items: center; gap: 0.5rem; min-width: 0;">
                    <span class="collab-email" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${req.email}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <select id="req-role-${req.id}" class="custom-input" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; width: auto; min-width: 80px; margin-bottom: 0;">
                        <option value="read">Viewer</option>
                        <option value="edit">Editor</option>
                    </select>
                    <button class="btn-primary btn-small" onclick="app.approveRequest('${req.id}', '${req.email}')" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;">Approve</button>
                    <button class="collab-remove" onclick="app.denyRequest('${req.id}')" title="Deny">
                        <span class="material-icons-round" style="font-size: 1.1rem;">close</span>
                    </button>
                </div>
            </li>
        `).join('');
    },
    
    approveRequest(reqId, email) {
        const roleSelect = document.getElementById(`req-role-${reqId}`);
        const role = roleSelect ? roleSelect.value : 'read';
        
        this.modifyStateSilent(() => {
            if (!state.collaborators) state.collaborators = {};
            state.collaborators[email] = role;
        });
        syncState(state);
        
        this.renderShareList();
        deleteRequest(reqId);
    },
    
    denyRequest(reqId) {
        deleteRequest(reqId);
    },

    // ==== ADD COLLABORATOR POPUP ====
    selectedShareRole: 'edit',

    openAddCollabModal() {
        this.selectedShareRole = 'edit';
        this.openModal('add-collab-modal');
        
        // For editors: hide the role toggle entirely (they can only share editor access)
        // For owner: show full role toggle
        const roleToggle = document.getElementById('role-toggle');
        const roleToggleContainer = roleToggle ? roleToggle.closest('div[style]') : null;
        
        if (permissionLevel === 'edit') {
            // Editors can only grant editor access
            if (roleToggleContainer) roleToggleContainer.style.display = 'none';
            this.selectedShareRole = 'edit';
        } else {
            // Owner sees full role toggle
            if (roleToggleContainer) roleToggleContainer.style.display = '';
            // Reset the role toggle to editor
            document.querySelectorAll('#role-toggle .role-btn').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-role') === 'edit');
            });
        }
        
        // Clear and focus email input
        const emailInput = document.getElementById('share-email');
        emailInput.value = '';
        setTimeout(() => emailInput.focus(), 100);
    },

    closeAddCollabModal(fromPopState = false) {
        this.closeModal(fromPopState);
    },

    setShareRole(role) {
        this.selectedShareRole = role;
        document.querySelectorAll('#role-toggle .role-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-role') === role);
        });
    },

    addCollaborator() {
        if (permissionLevel !== 'owner' && permissionLevel !== 'edit') return;
        const emailInput = document.getElementById('share-email');
        const email = emailInput.value.trim().toLowerCase();
        if (!email) return;

        // Basic email validation
        if (!email.includes('@') || !email.includes('.')) {
            emailInput.style.borderColor = '#e74c3c';
            emailInput.setAttribute('placeholder', 'Please enter a valid email');
            setTimeout(() => {
                emailInput.style.borderColor = '';
                emailInput.setAttribute('placeholder', 'name@example.com');
            }, 2000);
            return;
        }

        this.modifyStateSilent(() => {
            if (!state.collaborators) state.collaborators = {};
            state.collaborators[email] = this.selectedShareRole;
        });
        syncState(state);
        emailInput.value = '';
        this.renderShareList();
        this.closeAddCollabModal();
    },

    removeCollaborator(email) {
        if (permissionLevel !== 'owner') return;
        this.modifyStateSilent(() => {
            if (state.collaborators && state.collaborators[email]) {
                delete state.collaborators[email];
            }
        });
        syncState(state);
        this.renderShareList();
    },

    closeModal(fromPopState = false, closeAll = false) {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            document.activeElement.blur();
        }

        if (!this.modalStack) this.modalStack = [];

        if (closeAll) {
            this.modalStack.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.remove('active');
                    el.style.maxHeight = '';
                }
            });
            this.modalStack = [];
        } else if (this.modalStack.length > 0) {
            const closedId = this.modalStack.pop();
            const closedModal = document.getElementById(closedId);
            if (closedModal) {
                closedModal.classList.remove('active');
                closedModal.style.maxHeight = '';
            }
        }

        // If another modal is in the stack below, reactivate it so it becomes visible again
        if (this.modalStack.length > 0) {
            const nextModalId = this.modalStack[this.modalStack.length - 1];
            const nextModal = document.getElementById(nextModalId);
            if (nextModal) {
                nextModal.classList.add('active');
                if (nextModalId === 'question-space-modal') {
                    this.renderQuestionSpace();
                } else if (nextModalId === 'share-modal') {
                    this.renderShareList();
                    this.renderRequestsList();
                }
            }
        } else {
            // Stack is empty: close entire modal overlay
            document.body.classList.remove('modal-open');
            this.modalOverlay.classList.remove('active');
            this.modalOverlay.classList.remove('keyboard-open');
            this.modalOverlay.style.top = '';
            this.modalOverlay.style.height = '';
            this.modalOverlay.style.flexDirection = '';
            this.modalOverlay.style.alignItems = '';
            this.modalOverlay.style.justifyContent = '';
            this.modalOverlay.style.paddingBottom = '';
            document.querySelectorAll('.modal-card').forEach(card => {
                card.classList.remove('active');
                card.style.maxHeight = '';
            });
        }
        
        // Sync history if closed via UI button or backdrop click
        if (!fromPopState && !this._isPoppingState && history.state && history.state.modalId) {
            this._isPoppingState = true;
            history.back();
            setTimeout(() => { this._isPoppingState = false; }, 100);
        }

        ['new-day-date', 'new-event-title', 'share-email'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.value = '';
        });
        this.deleteTarget = null;
        this.insertAfterEventId = null;
        if (this.adjustModalForKeyboard) this.adjustModalForKeyboard();
    },

    promptAddDay() { this.openModal('add-day-modal'); },
    promptAddEvent(afterEventId = null) { 
        this.insertAfterEventId = afterEventId; 
        this.openModal('add-event-modal'); 
    },

    promptDelete(type, id, eventObj, customMessage = null) {
        if (eventObj && eventObj.stopPropagation) eventObj.stopPropagation();
        this.deleteTarget = { type, id };
        
        let displayType = type;
        if (type === 'query' || type === 'question') displayType = 'query';
        
        const msg = customMessage || `Are you sure you want to delete this ${displayType}? This action cannot be undone.`;
        document.getElementById('confirm-delete-message').textContent = msg;
        
        const btn = document.getElementById('btn-execute-delete');
        btn.onclick = () => this.executeDelete();
        
        this.openModal('confirm-delete-modal');
    },

    executeDelete() {
        if (!this.deleteTarget) return;
        const { type, id } = this.deleteTarget;
        
        if (type === 'day') {
            this.modifyStateAndRender(`Deleted a ${type}`, () => {
                state.days = state.days.filter(d => d.id !== id);
                const eventsToDelete = state.events.filter(e => e.dayId === id).map(e => e.id);
                state.events = state.events.filter(e => e.dayId !== id);
                const catsToDelete = state.categories.filter(c => eventsToDelete.includes(c.eventId)).map(c => c.id);
                state.categories = state.categories.filter(c => !eventsToDelete.includes(c.eventId));
                state.tasks = state.tasks.filter(t => !catsToDelete.includes(t.categoryId));
                if (state.activeDayId === id) state.activeDayId = state.days.length > 0 ? state.days[0].id : null;
            });
        } 
        else if (type === 'event') {
            this.modifyStateAndRender(`Deleted an ${type}`, () => {
                state.events = state.events.filter(e => e.id !== id);
                const catsToDelete = state.categories.filter(c => c.eventId === id).map(c => c.id);
                state.categories = state.categories.filter(c => c.eventId !== id);
                state.tasks = state.tasks.filter(t => !catsToDelete.includes(t.categoryId));
            });
        }
        else if (type === 'category') {
            this.modifyStateAndRender('Deleted a category', () => {
                state.categories = state.categories.filter(c => c.id !== id);
                state.tasks = state.tasks.filter(t => t.categoryId !== id);
            });
        }
        else if (type === 'task') {
            this.modifyStateAndRender('Deleted a task', () => {
                state.tasks = state.tasks.filter(t => t.id !== id);
            });
        }
        else if (type === 'query' || type === 'question') {
            this.modifyQueriesAndRender(`Deleted query`, () => {
                if (!state.questions) state.questions = [];
                state.questions = state.questions.filter(item => item.id !== id);
            });
        }
        else if (type === 'viewer') {
            const userId = id;
            const u = activeUsersData[userId];
            if (!state.blockedViewers) state.blockedViewers = {};
            state.blockedViewers[userId] = true;
            if (u && u.email) {
                state.blockedViewers[u.email] = true;
            }
            removePresenceUser(userId);
            syncState(state);
            this.selectedViewerUserId = null;
            this.renderViewersPanel();
        }
        
        this.closeModal();
    },

    deleteCategory(id, eventObj) {
        this.promptDelete('category', id, eventObj);
    },

    deleteTask(id, eventObj) {
        this.promptDelete('task', id, eventObj);
    },

    formatDateInfo(dateString) {
        if (!dateString) return { name: 'New Day', date: '', rawDate: '' };
        try {
            const dateObj = new Date(dateString + 'T00:00:00');
            const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            const d = dateObj.getDate();
            const suffix = (d === 1 || d === 21 || d === 31) ? 'st' : (d === 2 || d === 22) ? 'nd' : (d === 3 || d === 23) ? 'rd' : 'th';
            const monthName = dateObj.toLocaleDateString('en-US', { month: 'long' });
            return { name: dayName, date: `${d}${suffix} ${monthName}`, rawDate: dateString };
        } catch(e) {
            return { name: 'New Day', date: '', rawDate: '' };
        }
    },

    sortDays(days) {
        if (!days || !Array.isArray(days)) return days;
        days.sort((a, b) => {
            const dateA = a.rawDate || '';
            const dateB = b.rawDate || '';

            if (dateA && dateB) {
                if (dateA !== dateB) {
                    return dateA.localeCompare(dateB);
                }
            } else if (dateA) {
                return -1;
            } else if (dateB) {
                return 1;
            }

            const orderA = a.order !== undefined ? a.order : 0;
            const orderB = b.order !== undefined ? b.order : 0;
            return orderA - orderB;
        });

        days.forEach((day, idx) => {
            day.order = idx;
        });

        return days;
    },

    updateDayDate(id, dateString) {
        const day = state.days.find(d => d.id === id);
        if (day && dateString) {
            this.modifyStateAndRender('Updated day date', () => {
                const info = this.formatDateInfo(dateString);
                day.name = info.name;
                day.date = info.date;
                day.rawDate = info.rawDate;
                this.sortDays(state.days);
            });
        }
    },

    openDatePickerForDay(id) {
        const picker = document.getElementById(`date-picker-${id}`);
        if (!picker) return;
        // showPicker() is the modern API; fall back to .click() for older browsers
        try {
            picker.showPicker();
        } catch(e) {
            picker.click();
        }
    },

    saveDay() {
        const dateInput = document.getElementById('new-day-date').value;
        if (!dateInput) return;
        
        this.modifyStateAndRender('Added a new day', () => {
            const info = this.formatDateInfo(dateInput);
            const newDay = { id: 'day' + Date.now(), name: info.name, date: info.date, rawDate: info.rawDate, order: state.days.length };
            state.days.push(newDay);
            this.sortDays(state.days);
            state.activeDayId = newDay.id;
            this.userSelectedDayId = newDay.id;
        });
        
        this.closeModal();
    },

    saveEvent() {
        const titleInput = document.getElementById('new-event-title').value.trim();
        if (!titleInput) return;
        
        this.modifyStateAndRender(`Added new event "${titleInput}"`, () => {
            // Collapse all existing events & categories so only the new event is open
            state.events.forEach(e => e.collapsed = true);
            state.categories.forEach(c => c.collapsed = true);

            const newEvent = { 
                id: 'ev' + Date.now(), 
                dayId: state.activeDayId, 
                title: titleInput, 
                order: 0,
                collapsed: false,
                createdAt: Date.now()
            };

            // Get events belonging to current active day sorted by current order
            const currentDayEvents = state.events
                .filter(e => e.dayId === state.activeDayId)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));

            if (this.insertAfterEventId) {
                const targetIdx = currentDayEvents.findIndex(e => e.id === this.insertAfterEventId);
                if (targetIdx !== -1) {
                    currentDayEvents.splice(targetIdx + 1, 0, newEvent);
                } else {
                    currentDayEvents.push(newEvent);
                }
            } else {
                currentDayEvents.push(newEvent);
            }

            // Re-assign sequential order for active day events cleanly
            currentDayEvents.forEach((e, idx) => {
                e.order = idx;
            });

            // Ensure newEvent is added to state.events array
            if (!state.events.some(e => e.id === newEvent.id)) {
                state.events.push(newEvent);
            }
        });
        
        this.insertAfterEventId = null;
        this.closeModal();
    },

    saveCategory(eventId) {
        const input = document.getElementById(`new-cat-${eventId}`);
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;

        this.modifyStateAndRender(`Added new category "${text}"`, () => {
            const currentCats = state.categories.filter(c => c.eventId === eventId);
            // Collapse all other categories so only the newly created category is open
            state.categories.forEach(c => c.collapsed = true);
            state.events.forEach(e => { e.collapsed = (e.id !== eventId); });

            state.categories.push({
                id: 'cat' + Date.now(),
                eventId: eventId,
                title: text,
                order: currentCats.length,
                collapsed: false
            });
            input.value = ''; 
        });
    },

    openTaskModal(taskId = null, categoryId = null) {
        this.activeTaskData = { taskId, categoryId };
        
        const titleInput = document.getElementById('task-modal-title');
        const descInput = document.getElementById('task-modal-desc');
        const btn = document.getElementById('btn-save-task-modal');
        
        const canEdit = permissionLevel !== 'read';
        if (titleInput) titleInput.readOnly = !canEdit;
        if (descInput) descInput.readOnly = !canEdit;
        if (btn) btn.style.display = canEdit ? 'inline-flex' : 'none';
        
        if (taskId) {
            const task = state.tasks.find(t => t.id === taskId);
            titleInput.value = task ? task.text : '';
            descInput.value = task ? (task.description || '') : '';
        } else {
            titleInput.value = '';
            descInput.value = '';
        }
        
        if (canEdit && btn) {
            btn.onclick = () => this.saveTaskFromModal();
        }
        
        this.openModal('task-modal');
        setTimeout(() => {
            if (titleInput) {
                if (canEdit) titleInput.focus();
                this.resizeTextarea(titleInput);
            }
            if (descInput) {
                this.resizeTextarea(descInput);
            }
        }, 100);
    },

    saveTaskFromModal() {
        if (!this.activeTaskData) return;
        const titleInput = document.getElementById('task-modal-title');
        const descInput = document.getElementById('task-modal-desc');
        const text = titleInput.value.trim();
        const description = descInput.value.trim();
        if (!text) return;
        
        this.modifyStateAndRender(`Saved task "${text}"`, () => {
            if (this.activeTaskData.taskId) {
                const task = state.tasks.find(t => t.id === this.activeTaskData.taskId);
                if (task) {
                    task.text = text;
                    task.description = description;
                }
            } else if (this.activeTaskData.categoryId) {
                const currentTasks = state.tasks.filter(t => t.categoryId === this.activeTaskData.categoryId);
                const parentCat = state.categories.find(c => c.id === this.activeTaskData.categoryId);
                const parentEvent = parentCat ? state.events.find(e => e.id === parentCat.eventId) : null;
                const isCompleted = parentEvent ? !!parentEvent.completed : false;
                state.tasks.push({
                    id: 'tsk' + Date.now(),
                    categoryId: this.activeTaskData.categoryId,
                    text: text,
                    description: description,
                    completed: isCompleted,
                    order: currentTasks.length
                });
            }
        });
        
        this.closeModal();
    },

    toggleTask(taskId) {
        this.modifyStateAndRender('Toggled task completion', () => {
            const task = state.tasks.find(t => t.id === taskId);
            if (task) task.completed = !task.completed;
        });
    },

    toggleEventComplete(eventId) {
        this.modifyStateAndRender('Toggled event completion', () => {
            const event = state.events.find(e => e.id === eventId);
            if (event) {
                event.completed = !event.completed;
                const eventCatIds = new Set(
                    (state.categories || [])
                        .filter(c => c.eventId === eventId)
                        .map(c => c.id)
                );
                (state.tasks || []).forEach(task => {
                    if (eventCatIds.has(task.categoryId)) {
                        task.completed = event.completed;
                    }
                });
            }
        });
    },

    // ==== QUERIES / QUESTION SPACE METHODS ====
    toggleQSComposer(show) {
        const createSec = document.getElementById('qs-create-section');
        const toggleBtn = document.getElementById('qs-toggle-composer-btn');
        if (show === undefined) {
            this.showQSComposer = createSec ? createSec.classList.contains('expanded') : false;
        } else {
            this.showQSComposer = !!show;
        }
        if (createSec) {
            createSec.classList.toggle('expanded', this.showQSComposer);
        }
        if (toggleBtn) {
            toggleBtn.classList.toggle('active', this.showQSComposer);
            toggleBtn.innerHTML = this.showQSComposer 
                ? '<span class="material-icons-round" style="font-size: 1rem;">expand_less</span> Close Form'
                : '<span class="material-icons-round" style="font-size: 1rem;">add_comment</span> Post Query';
        }
    },

    filterQSEventId: null,

    toggleQueriesListExpand(show) {
        const wrapper = document.getElementById('qs-list-wrapper');
        const icon = document.getElementById('qs-list-toggle-icon');
        if (show === undefined) {
            this.showQueriesList = wrapper ? (!wrapper.classList.contains('expanded')) : false;
        } else {
            this.showQueriesList = !!show;
        }
        if (wrapper) {
            wrapper.classList.toggle('expanded', this.showQueriesList);
        }
        if (icon) {
            icon.style.transform = this.showQueriesList ? 'rotate(180deg)' : 'rotate(0deg)';
        }
        if (this.showQueriesList) {
            this.renderQuestionSpace();
        }
    },

    openQuestionSpaceModal(eventId = null, expandQueries = false) {
        if (!state.questions) state.questions = [];
        this.filterQSEventId = eventId;
        
        this.collapsedQSEvents = {};
        this.collapsedGeneralQueries = !eventId ? false : true;
        this.showQueriesList = !!expandQueries;

        if (eventId) {
            this.qsFilterTab = 'all';
            this.setQuestionTagMode('event');
            this.selectedQSEventId = eventId;
            if (expandQueries) {
                this.collapsedQSEvents[eventId] = false;
            }
        } else {
            this.qsFilterTab = this.qsFilterTab || 'all';
            this.collapsedGeneralQueries = false;
            this.setQuestionTagMode('general');
            this.clearQSEventSelection();
        }

        this.editingQuestionId = null;
        
        this.toggleQSComposer(!expandQueries);
        this.toggleQueriesListExpand(this.showQueriesList);
        
        this.renderQuestionSpace();
        this.openModal('question-space-modal');
    },

    clearQSEventFilter() {
        this.filterQSEventId = null;
        this.renderQuestionSpace();
    },

    setQSFilterTab(tab) {
        this.qsFilterTab = tab;
        if (tab === 'general') {
            this.collapsedGeneralQueries = false;
        }
        this.renderQuestionSpace();
    },

    toggleQSEventCollapse(eventId) {
        if (!this.collapsedQSEvents) this.collapsedQSEvents = {};
        const isCollapsed = this.collapsedQSEvents[eventId] !== false;
        this.collapsedQSEvents[eventId] = !isCollapsed;
        this.renderQuestionSpace();
    },

    toggleQSGeneralCollapse() {
        this.collapsedGeneralQueries = !this.collapsedGeneralQueries;
        this.renderQuestionSpace();
    },

    startEditQuestion(questionId) {
        this.editingQuestionId = questionId;
        this.renderQuestionSpace();
    },

    cancelEditQuestion() {
        this.editingQuestionId = null;
        this.renderQuestionSpace();
    },

    saveEditedQuestion(questionId) {
        const textInput = document.getElementById(`edit-q-text-${questionId}`);
        const eventSelect = document.getElementById(`edit-q-event-${questionId}`);
        const newText = textInput ? textInput.value.trim() : '';
        const newEventId = eventSelect ? (eventSelect.value === 'general' ? null : eventSelect.value) : null;

        if (!newText) return;

        this.modifyQueriesAndRender('Edited query', () => {
            const q = state.questions.find(item => item.id === questionId);
            if (q) {
                q.text = newText;
                q.eventId = newEventId;
            }
        });

        this.editingQuestionId = null;
    },

    setQuestionTagMode(mode) {
        this.qsTagMode = mode; // 'general' or 'event'
        const btnGeneral = document.getElementById('qs-tag-btn-general');
        const btnEvent = document.getElementById('qs-tag-btn-event');
        const tagTypeToggle = document.getElementById('qs-tag-type-toggle');
        const lockedBadge = document.getElementById('qs-event-locked-badge');
        const lockedTitle = document.getElementById('qs-locked-event-title');
        const pickerContainer = document.getElementById('qs-event-picker-container');

        if (this.filterQSEventId) {
            const ev = state.events ? state.events.find(e => e.id === this.filterQSEventId) : null;
            if (tagTypeToggle) tagTypeToggle.style.display = 'none';
            if (pickerContainer) pickerContainer.style.display = 'none';
            if (lockedBadge) lockedBadge.style.display = 'flex';
            if (lockedTitle && ev) lockedTitle.textContent = ev.title || 'This event';
            this.qsTagMode = 'event';
            this.selectedQSEventId = this.filterQSEventId;
            return;
        }

        if (lockedBadge) lockedBadge.style.display = 'none';
        if (tagTypeToggle) tagTypeToggle.style.display = 'flex';

        if (mode === 'general') {
            if (btnGeneral) btnGeneral.classList.add('active');
            if (btnEvent) btnEvent.classList.remove('active');
            if (pickerContainer) pickerContainer.style.display = 'none';
            this.selectedQSEventId = null;
        } else {
            if (btnGeneral) btnGeneral.classList.remove('active');
            if (btnEvent) btnEvent.classList.add('active');
            if (pickerContainer) pickerContainer.style.display = 'block';
            this.populateQSDayFilterSelect();
            this.filterQSEventList('');
            const searchInput = document.getElementById('qs-event-search-input');
            if (searchInput) {
                searchInput.focus();
            }
        }
    },

    populateQSDayFilterSelect() {
        const selectEl = document.getElementById('qs-day-filter-select');
        if (!selectEl) return;

        const days = state.days || [];
        if (!this.selectedQSDayId) {
            this.selectedQSDayId = state.activeDayId || (days[0] ? days[0].id : 'all');
        }

        let optionsHTML = `<option value="all" ${this.selectedQSDayId === 'all' ? 'selected' : ''}>All Days</option>`;
        optionsHTML += days.map(day => {
            const isSelected = this.selectedQSDayId === day.id;
            const label = day.formattedDate || day.rawDate || 'Day';
            return `<option value="${day.id}" ${isSelected ? 'selected' : ''}>${label}</option>`;
        }).join('');

        selectEl.innerHTML = optionsHTML;
    },

    setQSDayFilter(dayId) {
        this.selectedQSDayId = dayId;
        const searchInput = document.getElementById('qs-event-search-input');
        const query = searchInput ? searchInput.value : '';
        this.filterQSEventList(query);
    },

    filterQSEventList(query = '') {
        const listEl = document.getElementById('qs-event-dropdown-list');
        if (!listEl) return;

        const events = state.events || [];
        const days = state.days || [];

        const q = query.toLowerCase().trim();

        const filtered = events.filter(e => {
            const day = days.find(d => d.id === e.dayId);
            const titleMatch = (e.title || '').toLowerCase().includes(q);
            const dayLabel = day ? (day.formattedDate || day.rawDate || '') : '';
            const dateMatch = dayLabel.toLowerCase().includes(q);

            const matchesSearch = !q || titleMatch || dateMatch;
            const matchesDayFilter = (this.selectedQSDayId === 'all') || !this.selectedQSDayId || (e.dayId === this.selectedQSDayId) || (q && dateMatch);

            return matchesSearch && matchesDayFilter;
        });

        if (filtered.length === 0) {
            listEl.innerHTML = `<div style="padding: 0.75rem; text-align: center; color: var(--text-muted); font-size: 0.82rem;">No matching events found.</div>`;
            return;
        }

        listEl.innerHTML = filtered.map(ev => {
            const day = days.find(d => d.id === ev.dayId);
            const dayLabel = day ? (day.formattedDate || day.rawDate || 'Day') : '';
            const isSelected = this.selectedQSEventId === ev.id;
            return `
                <div class="qs-event-option-item ${isSelected ? 'selected' : ''}" onclick="app.selectQSEvent('${ev.id}')">
                    <div style="display: flex; align-items: center; gap: 0.4rem; flex: 1; min-width: 0;">
                        <span class="material-icons-round" style="font-size: 1.05rem; color: ${isSelected ? '#f39c12' : 'var(--text-muted)'};">${isSelected ? 'check_circle' : 'event'}</span>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${ev.title || 'Untitled Event'}</span>
                    </div>
                    ${dayLabel ? `<span class="qs-event-option-day" style="flex-shrink: 0; margin-left: 0.5rem;">${dayLabel}</span>` : ''}
                </div>
            `;
        }).join('');
    },

    selectQSEvent(eventId) {
        if (this.selectedQSEventId === eventId) {
            this.selectedQSEventId = null;
        } else {
            this.selectedQSEventId = eventId;
        }
        const searchInput = document.getElementById('qs-event-search-input');
        const query = searchInput ? searchInput.value : '';
        this.filterQSEventList(query);
    },

    clearQSEventSelection() {
        this.selectedQSEventId = null;
        this.selectedQSDayId = null;
        const searchInput = document.getElementById('qs-event-search-input');
        if (searchInput) searchInput.value = '';
    },

    openAddQuestionModal(eventId) {
        const ev = state.events.find(e => e.id === eventId);
        if (!ev) return;
        
        this.activeQuestionEventId = eventId;
        const nameEl = document.getElementById('add-q-event-name');
        const textInput = document.getElementById('add-q-text');
        if (nameEl) nameEl.innerText = ev.title || 'Untitled Event';
        if (textInput) textInput.value = '';
        
        this.openModal('add-question-modal');
        setTimeout(() => textInput && textInput.focus(), 100);
    },

    saveEventQuestion() {
        if (!this.activeQuestionEventId) return;
        const textInput = document.getElementById('add-q-text');
        const text = textInput ? textInput.value.trim() : '';
        if (!text) return;

        this.modifyQueriesAndRender(`Added query to event`, () => {
            if (!state.questions) state.questions = [];
            state.questions.push({
                id: 'q_' + Date.now(),
                eventId: this.activeQuestionEventId,
                text: text,
                answered: false,
                answerText: '',
                createdAt: Date.now()
            });
        });

        this.closeModal();
    },

    submitQuestionFromSpace() {
        const textInput = document.getElementById('qs-input-text');
        const text = textInput ? textInput.value.trim() : '';
        const eventId = this.filterQSEventId || ((this.qsTagMode === 'event') ? this.selectedQSEventId : null);
        if (!text) return;

        this.modifyQueriesAndRender(`Posted new query`, () => {
            if (!state.questions) state.questions = [];
            state.questions.push({
                id: 'q_' + Date.now(),
                eventId: eventId || null,
                text: text,
                answered: false,
                answerText: '',
                createdAt: Date.now()
            });
        });

        if (textInput) textInput.value = '';
        this.closeModal();
    },

    toggleQuestionAnswered(questionId) {
        this.modifyQueriesAndRender(`Updated query status`, () => {
            if (!state.questions) state.questions = [];
            const q = state.questions.find(item => item.id === questionId);
            if (q) {
                q.answered = !q.answered;
            }
        });
    },

    saveQuestionAnswer(questionId, answerText) {
        this.modifyQueriesAndRender(`Answered query`, () => {
            if (!state.questions) state.questions = [];
            const q = state.questions.find(item => item.id === questionId);
            if (q) {
                q.answerText = answerText;
                q.answered = true;
            }
        });
    },

    deleteQuestion(questionId, eventObj) {
        this.promptDelete('query', questionId, eventObj, 'Are you sure you want to delete this query?');
    },

    setQSSortMode(mode) {
        this.qsSortMode = mode;
        this.renderQuestionSpace();
    },

    renderFilterTabsHTML(allQ) {
        let targetQ = allQ;
        if (this.filterQSEventId) {
            targetQ = allQ.filter(q => q.eventId === this.filterQSEventId);
        }

        const totalCount = targetQ.length;
        const unresolvedCount = targetQ.filter(q => !q.answered).length;
        const doneCount = targetQ.filter(q => q.answered).length;
        const generalCount = targetQ.filter(q => !q.eventId || !state.events.some(e => e.id === q.eventId)).length;
        const eventTaggedCount = totalCount - generalCount;

        const currentTab = this.qsFilterTab || 'all';

        const tabs = [
            { id: 'all', label: `All (${totalCount})` },
            { id: 'unresolved', label: `Unresolved (${unresolvedCount})` },
            { id: 'done', label: `Done (${doneCount})` },
        ];

        if (!this.filterQSEventId) {
            tabs.push({ id: 'general', label: `General (${generalCount})` });
            tabs.push({ id: 'event', label: `Event Tagged (${eventTaggedCount})` });
        }

        return tabs.map(t => `
            <button type="button" class="qs-day-chip ${currentTab === t.id ? 'active' : ''}" onclick="app.setQSFilterTab('${t.id}')">
                ${t.label}
            </button>
        `).join('');
    },

    renderQuestionSpace() {
        const listEl = document.getElementById('qs-questions-list');
        const filterTabsEl = document.getElementById('qs-filter-tabs');
        if (!listEl) return;
        
        const questions = state.questions || [];
        const canEdit = true; // Queries feature is available for everyone including View Access users

        // Dynamically update the toggle bar unresolved count badge
        const countBadge = document.getElementById('qs-list-toggle-count-badge');
        const targetScopeQuestions = this.filterQSEventId 
            ? questions.filter(q => q.eventId === this.filterQSEventId)
            : questions;
        const totalUnresolved = targetScopeQuestions.filter(q => !q.answered).length;
        if (countBadge) {
            countBadge.textContent = `${totalUnresolved} unresolved`;
        }

        if (filterTabsEl) {
            filterTabsEl.innerHTML = this.renderFilterTabsHTML(questions);
        }

        if (!this.qsSortMode) this.qsSortMode = 'unresolved_desc';

        // Filter by specific event if opened from timeline event icon/badge
        let filtered = [...questions];
        if (this.filterQSEventId) {
            filtered = filtered.filter(q => q.eventId === this.filterQSEventId);
        }

        // Apply Tab Filter
        const tab = this.qsFilterTab || 'all';
        if (tab === 'unresolved') filtered = filtered.filter(q => !q.answered);
        else if (tab === 'done') filtered = filtered.filter(q => q.answered);
        else if (tab === 'general' && !this.filterQSEventId) filtered = filtered.filter(q => !q.eventId || !state.events.some(e => e.id === q.eventId));
        else if (tab === 'event' && !this.filterQSEventId) filtered = filtered.filter(q => q.eventId && state.events.some(e => e.id === q.eventId));

        const targetEvent = this.filterQSEventId ? state.events.find(e => e.id === this.filterQSEventId) : null;
        let eventFilterBanner = '';
        if (targetEvent) {
            eventFilterBanner = `
                <div style="display: flex; align-items: center; padding: 0.45rem 0.7rem; margin-bottom: 0.65rem; background: rgba(243, 156, 18, 0.12); border: 1px solid rgba(243, 156, 18, 0.3); border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #f39c12; font-weight: 600; min-width: 0;">
                        <span class="material-icons-round" style="font-size: 1rem; flex-shrink: 0;">event</span>
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Queries for: <strong style="color: var(--text-main);">${targetEvent.title}</strong></span>
                    </div>
                </div>
            `;
        }

        if (filtered.length === 0) {
            listEl.innerHTML = eventFilterBanner + `<div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
                <span class="material-icons-round" style="font-size: 2.5rem; opacity: 0.5; color: #f39c12;">help_outline</span>
                <p style="margin-top: 0.5rem; font-size: 0.95rem; color: var(--text-main);">No matching queries found for this view.</p>
                <p style="font-size: 0.82rem; opacity: 0.7;">Post a question above to get started!</p>
            </div>`;
            return;
        }

        const generalQuestions = this.filterQSEventId ? [] : filtered.filter(q => !q.eventId || !state.events.some(e => e.id === q.eventId));
        
        // Group timeline-tagged questions by Event
        const eventGroups = [];
        const eventMap = {};
        
        filtered.forEach(q => {
            if (q.eventId) {
                const ev = state.events.find(e => e.id === q.eventId);
                if (ev) {
                    if (!eventMap[ev.id]) {
                        eventMap[ev.id] = { event: ev, questions: [] };
                        eventGroups.push(eventMap[ev.id]);
                    }
                    eventMap[ev.id].questions.push(q);
                }
            }
        });

        // Calculate unresolved & total counts for each event group
        eventGroups.forEach(g => {
            g.unresolvedCount = g.questions.filter(q => !q.answered).length;
            g.totalCount = g.questions.length;
        });

        // Sort Event Groups according to this.qsSortMode
        const sortMode = this.qsSortMode || 'unresolved_desc';
        if (sortMode === 'unresolved_desc') {
            eventGroups.sort((a, b) => b.unresolvedCount - a.unresolvedCount || b.totalCount - a.totalCount);
        } else if (sortMode === 'total_desc') {
            eventGroups.sort((a, b) => b.totalCount - a.totalCount);
        } else if (sortMode === 'newest') {
            eventGroups.sort((a, b) => {
                const newestA = Math.max(...a.questions.map(q => q.createdAt || 0));
                const newestB = Math.max(...b.questions.map(q => q.createdAt || 0));
                return newestB - newestA;
            });
        }

        let html = '';

        if (generalQuestions.length > 0) {
            const genUnresolved = generalQuestions.filter(q => !q.answered).length;
            const isGenCollapsed = this.collapsedGeneralQueries !== false;
            const genCards = generalQuestions.map(q => this.renderQuestionCardHTML(q, canEdit)).join('');
            html += `<div class="qs-section-header" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; margin-bottom: 0.4rem; padding: 0.4rem 0.6rem; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);" onclick="app.toggleQSGeneralCollapse()">
                <div style="display: flex; align-items: center; gap: 0.4rem;">
                    <span class="material-icons-round" style="font-size: 1rem; color: #f39c12;">chat_bubble_outline</span>
                    <span style="font-weight: 600; font-size: 0.85rem;">General Queries</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.35rem;">
                    ${genUnresolved > 0 ? `<span style="font-size: 0.68rem; background: rgba(243, 156, 18, 0.15); color: #f39c12; border: 1px solid rgba(243, 156, 18, 0.3); padding: 0.1rem 0.45rem; border-radius: 100px; font-weight: 600;">${genUnresolved} unresolved</span>` : ''}
                    <span style="font-size: 0.68rem; background: rgba(255,255,255,0.08); padding: 0.1rem 0.45rem; border-radius: 100px;">${generalQuestions.length} total</span>
                    <span class="material-icons-round qs-group-caret" style="font-size: 1.1rem; color: var(--text-muted); transform: ${isGenCollapsed ? 'rotate(0deg)' : 'rotate(180deg)'};">expand_more</span>
                </div>
            </div>
            <div class="qs-group-wrapper ${isGenCollapsed ? '' : 'expanded'}">
                <div class="qs-group-inner">
                    ${genCards}
                </div>
            </div>`;
        }

        if (!this.collapsedQSEvents) this.collapsedQSEvents = {};

        // Render event query groups with collapsible headers when in global view, or render cards directly when filtered to a specific event
        eventGroups.forEach(group => {
            const groupCards = group.questions.map(q => this.renderQuestionCardHTML(q, canEdit)).join('');
            if (this.filterQSEventId) {
                html += groupCards;
            } else {
                const isCollapsed = this.collapsedQSEvents[group.event.id] !== false;
                const unresolvedCount = group.unresolvedCount;
                const day = state.days.find(d => d.id === group.event.dayId);
                const dayLabel = day ? (day.formattedDate || day.rawDate || '') : '';

                html += `
                    <div class="qs-section-header" style="display: flex; align-items: flex-start; justify-content: space-between; cursor: pointer; user-select: none; margin-top: 0.6rem; margin-bottom: 0.4rem; padding: 0.5rem 0.65rem; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.06);" 
                         onclick="app.toggleQSEventCollapse('${group.event.id}')">
                        <div style="display: flex; align-items: flex-start; gap: 0.4rem; flex: 1; min-width: 0;">
                            <span class="material-icons-round" style="font-size: 1.05rem; color: #f39c12; flex-shrink: 0; margin-top: 1px;">event</span>
                            <div style="display: flex; flex-direction: column; flex: 1; min-width: 0;">
                                <span style="font-weight: 600; font-size: 0.86rem; color: var(--text-main); line-height: 1.3; word-break: break-word;">${group.event.title || 'Untitled Event'}</span>
                                ${dayLabel ? `<span style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">${dayLabel}</span>` : ''}
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; margin-left: 0.5rem; align-self: center;">
                            ${unresolvedCount > 0 
                                ? `<span style="font-size: 0.7rem; background: rgba(243, 156, 18, 0.18); color: #f39c12; border: 1px solid rgba(243, 156, 18, 0.4); padding: 0.1rem 0.45rem; border-radius: 100px; font-weight: 700;">${unresolvedCount} unresolved</span>` 
                                : `<span style="font-size: 0.7rem; background: rgba(46, 204, 113, 0.15); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.3); padding: 0.1rem 0.45rem; border-radius: 100px; font-weight: 600;">Resolved</span>`}
                            <span class="material-icons-round qs-group-caret" style="font-size: 1.1rem; color: var(--text-muted); flex-shrink: 0; transform: ${isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)'};">expand_more</span>
                        </div>
                    </div>
                    <div class="qs-group-wrapper ${isCollapsed ? '' : 'expanded'}">
                        <div class="qs-group-inner">
                            ${groupCards}
                        </div>
                    </div>
                `;
            }
        });

        listEl.innerHTML = eventFilterBanner + html;
    },

    renderQuestionCardHTML(q, canEdit) {
        if (this.editingQuestionId === q.id) {
            const events = state.events || [];
            return `
                <div class="qs-card" style="border: 1px solid rgba(243, 156, 18, 0.4); background: rgba(243, 156, 18, 0.05); margin-bottom: 0.5rem; padding: 0.75rem;">
                    <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                        <label style="font-size: 0.78rem; color: #f39c12; font-weight: 600;">Edit Query & Tag</label>
                        <textarea id="edit-q-text-${q.id}" class="custom-input" rows="2" style="font-size: 0.85rem; resize: none; width: 100%; box-sizing: border-box;">${q.text || ''}</textarea>
                        
                        <div style="display: flex; gap: 0.5rem; align-items: center; justify-content: space-between; flex-wrap: wrap;">
                            <select id="edit-q-event-${q.id}" class="custom-input" style="width: auto; max-width: 200px; font-size: 0.8rem; height: 32px; padding: 0 0.5rem;">
                                <option value="general" ${!q.eventId ? 'selected' : ''}>General Query</option>
                                ${events.map(e => `<option value="${e.id}" ${q.eventId === e.id ? 'selected' : ''}>Event: ${e.title || 'Untitled'}</option>`).join('')}
                            </select>

                            <div style="display: flex; gap: 0.4rem; align-items: center;">
                                <button class="btn-ghost" style="padding: 0.3rem 0.75rem; font-size: 0.78rem; height: 32px;" onclick="app.cancelEditQuestion()">Cancel</button>
                                <button class="btn-primary" style="padding: 0.3rem 0.85rem; font-size: 0.78rem; height: 32px;" onclick="app.saveEditedQuestion('${q.id}')">Save Changes</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        const isDone = !!q.answered;

        return `
            <div class="qs-card ${isDone ? 'answered' : 'unanswered'}" style="margin-bottom: 0.5rem; padding: 0.75rem; background: rgba(255,255,255,0.03); border: 1px solid ${isDone ? 'rgba(46, 204, 113, 0.15)' : 'rgba(255,255,255,0.08)'}; border-radius: 10px;">
                <!-- Top Card Header: Status Badge on Left, Action Buttons on Right -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; gap: 0.5rem;">
                    <span class="badge-status" style="font-size: 0.7rem; padding: 0.12rem 0.5rem; border-radius: 100px; font-weight: 600; background: ${isDone ? 'rgba(46, 204, 113, 0.15)' : 'rgba(243, 156, 18, 0.15)'}; color: ${isDone ? '#2ecc71' : '#f39c12'}; border: 1px solid ${isDone ? 'rgba(46, 204, 113, 0.3)' : 'rgba(243, 156, 18, 0.3)'};">
                        ${isDone ? 'Resolved' : 'Unresolved'}
                    </span>

                    <div style="display: flex; align-items: center; gap: 0.25rem;">
                        ${canEdit ? `
                        <button class="btn-ghost" style="padding: 0.2rem 0.55rem; font-size: 0.75rem; display: flex; align-items: center; gap: 0.2rem; color: ${isDone ? '#2ecc71' : 'var(--text-muted)'}; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;" 
                                title="${isDone ? 'Mark as Unresolved' : 'Mark as Done'}" 
                                onclick="app.toggleQuestionAnswered('${q.id}')">
                            <span class="material-icons-round" style="font-size: 0.9rem;">${isDone ? 'check_circle' : 'radio_button_unchecked'}</span>
                            <span>${isDone ? 'Done' : 'Mark Done'}</span>
                        </button>
                        <button class="btn-ghost" style="padding: 0.2rem 0.35rem; font-size: 0.8rem; color: var(--text-muted);" 
                                title="Edit Query" 
                                onclick="app.startEditQuestion('${q.id}')">
                            <span class="material-icons-round" style="font-size: 0.95rem;">edit</span>
                        </button>
                        <button class="btn-ghost" style="padding: 0.2rem 0.35rem; font-size: 0.8rem; color: #e74c3c;" 
                                title="Delete Query" 
                                onclick="app.deleteQuestion('${q.id}')">
                            <span class="material-icons-round" style="font-size: 0.95rem;">delete</span>
                        </button>` : ''}
                    </div>
                </div>

                <!-- Full Width Question Text -->
                <div class="qs-question-text" style="font-size: 0.88rem; line-height: 1.4; color: var(--text-main); margin-bottom: 0.4rem; ${isDone ? 'text-decoration: line-through; opacity: 0.7;' : ''}">
                    ${q.text}
                </div>

                <!-- Answer Display / Input Form -->
                ${q.answerText ? `
                    <div class="qs-answer-text" style="margin-top: 0.4rem; background: rgba(46, 204, 113, 0.08); border: 1px solid rgba(46, 204, 113, 0.2); border-radius: 6px; padding: 0.4rem 0.65rem; font-size: 0.82rem; color: var(--text-main);">
                        <strong style="color: #2ecc71;">Answer:</strong> ${q.answerText}
                    </div>
                ` : (canEdit ? `
                    <div style="display: flex; gap: 0.4rem; margin-top: 0.4rem; align-items: center;">
                        <input type="text" id="ans-input-${q.id}" class="custom-input" placeholder="Write an answer..." 
                               style="font-size: 0.78rem !important; height: 30px !important; padding: 0 0.6rem !important; flex: 1; border-radius: 6px; box-sizing: border-box; background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1);">
                        <button class="btn-ghost" style="height: 30px !important; padding: 0 0.65rem !important; font-size: 0.78rem !important; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; font-weight: 500; display: flex; align-items: center; flex-shrink: 0;" 
                                onclick="const val = document.getElementById('ans-input-${q.id}').value.trim(); if(val) app.saveQuestionAnswer('${q.id}', val);">Answer</button>
                    </div>
                ` : '')}
            </div>
        `;
    },

    updateQuestionHeaderBadge() {
        const badgeEl = document.getElementById('qs-header-badge');
        if (!badgeEl) return;
        const questions = state.questions || [];
        const unansweredCount = questions.filter(q => !q.answered).length;
        if (unansweredCount > 0) {
            badgeEl.style.display = 'inline-block';
            badgeEl.innerText = unansweredCount;
        } else {
            badgeEl.style.display = 'none';
        }
    },

    // ==== RENDERING ====
    renderPreservingFocusAndScroll() {
        // Capture scroll positions before render
        const scrollX = window.scrollX || window.pageXOffset || 0;
        const scrollY = window.scrollY || window.pageYOffset || 0;
        const eventsListScrollTop = this.eventsList ? this.eventsList.scrollTop : 0;
        const tabsContainerScrollLeft = this.tabsContainer ? this.tabsContainer.scrollLeft : 0;

        // Capture active focus and caret selection
        const activeEl = document.activeElement;
        let focusInfo = null;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable || activeEl.id === window.currentFocusedField)) {
            const id = activeEl.id;
            const tagName = activeEl.tagName;
            const isContentEditable = activeEl.isContentEditable;
            let start = null, end = null, val = null;

            if (!isContentEditable && typeof activeEl.selectionStart === 'number') {
                start = activeEl.selectionStart;
                end = activeEl.selectionEnd;
                val = activeEl.value;
            } else if (isContentEditable) {
                val = activeEl.innerText;
                try {
                    const sel = window.getSelection();
                    if (sel && sel.rangeCount > 0) {
                        const range = sel.getRangeAt(0);
                        start = range.startOffset;
                        end = range.endOffset;
                    }
                } catch (e) {}
            }

            focusInfo = { id, tagName, isContentEditable, start, end, val };
        }

        // Perform standard render
        this.renderTitle();
        this.render();

        // Restore focus and caret position if applicable
        if (focusInfo && focusInfo.id) {
            const targetEl = document.getElementById(focusInfo.id);
            if (targetEl) {
                if (focusInfo.val !== null) {
                    if (focusInfo.isContentEditable) {
                        if (targetEl.innerText !== focusInfo.val) {
                            targetEl.innerText = focusInfo.val;
                        }
                    } else if (focusInfo.tagName === 'INPUT' || focusInfo.tagName === 'TEXTAREA') {
                        if (targetEl.value !== focusInfo.val) {
                            targetEl.value = focusInfo.val;
                        }
                    }
                }

                if (document.activeElement !== targetEl) {
                    targetEl.focus();
                }

                if (focusInfo.start !== null && focusInfo.end !== null) {
                    try {
                        if (focusInfo.isContentEditable) {
                            const sel = window.getSelection();
                            const range = document.createRange();
                            if (targetEl.childNodes.length > 0) {
                                const textNode = targetEl.childNodes[0];
                                const maxLen = textNode.length || 0;
                                const safeStart = Math.min(focusInfo.start, maxLen);
                                const safeEnd = Math.min(focusInfo.end, maxLen);
                                range.setStart(textNode, safeStart);
                                range.setEnd(textNode, safeEnd);
                                sel.removeAllRanges();
                                sel.addRange(range);
                            }
                        } else if (typeof targetEl.setSelectionRange === 'function') {
                            targetEl.setSelectionRange(focusInfo.start, focusInfo.end);
                        }
                    } catch (e) {}
                }
            }
        }

        // Restore exact scroll positions instantly
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
        if (this.eventsList) this.eventsList.scrollTop = eventsListScrollTop;
        if (this.tabsContainer) this.tabsContainer.scrollLeft = tabsContainerScrollLeft;
    },

    renderTitle() {
        if (this.titleInput) {
            this.titleInput.value = state.title || 'Wedding Timeline';
            this.resizeTextarea(this.titleInput);
            if (permissionLevel === 'read') {
                this.titleInput.readOnly = true;
                this.titleInput.style.pointerEvents = 'none';
            } else {
                this.titleInput.readOnly = false;
                this.titleInput.style.pointerEvents = 'auto';
            }
        }
    },

    render() {
        if (!state) return; 
        if (!state.questions) state.questions = [];

        const isSearching = !!(this.searchQuery && this.searchQuery.trim().length > 0);
        const dayNavWrapper = document.querySelector('.day-navigation-wrapper');
        if (dayNavWrapper) {
            dayNavWrapper.style.display = isSearching ? 'none' : 'flex';
        }

        this.renderTabs();
        this.renderEvents();
        this.updateQuestionHeaderBadge();
        if (permissionLevel !== 'read') this.initSortable();
        this.applyPermissionUI();

        if (!app.hasScrolledToActive) {
            app.hasScrolledToActive = true;
            setTimeout(() => {
                const activeEl = document.querySelector('.active-event');
                if (activeEl) {
                    activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 300);
        }
    },

    initSortable() {
        if (typeof Sortable === 'undefined') return;

        // Destroy old Sortable instances to prevent duplicates
        if (this._sortableInstances) {
            this._sortableInstances.forEach(s => s.destroy());
        }
        this._sortableInstances = [];

        const commonOptions = {
            animation: 120,
            scroll: true,
            bubbleScroll: true,
            forceFallback: true,
            fallbackOnBody: true,
            fallbackTolerance: 1,
            delay: 50,
            delayOnTouchOnly: true,
            touchStartThreshold: 1,
            swapThreshold: 0.35,
            scrollSensitivity: 150,
            scrollSpeed: 350,
        };

        const eventsListEl = document.getElementById('events-list');
        if (eventsListEl) {
            this._sortableInstances.push(new Sortable(eventsListEl, {
                ...commonOptions,
                handle: '.event-header .drag-handle',
                draggable: '.event-block',
                onStart: (evt) => {
                    if (evt.fallback) {
                        const width = evt.item.getBoundingClientRect().width;
                        evt.fallback.style.width = width + 'px';
                    }
                },
                onEnd: (evt) => {
                    const eventEls = Array.from(eventsListEl.querySelectorAll(':scope > .event-block'));
                    this.modifyStateAndRender('Reordered events', () => {
                        eventEls.forEach((el, idx) => {
                            const evId = el.getAttribute('data-event-id');
                            const ev = state.events.find(e => e.id === evId);
                            if (ev) ev.order = idx;
                        });
                    });
                }
            }));
        }
        
        document.querySelectorAll('.event-details').forEach(el => {
            this._sortableInstances.push(new Sortable(el, {
                ...commonOptions,
                handle: '.category-header .drag-handle',
                draggable: '.category',
                onStart: (evt) => {
                    if (evt.fallback) {
                        const width = evt.item.getBoundingClientRect().width;
                        evt.fallback.style.width = width + 'px';
                    }
                },
                onEnd: (evt) => {
                    const catEls = Array.from(el.querySelectorAll(':scope > .category'));
                    this.modifyStateAndRender('Reordered categories', () => {
                        catEls.forEach((catEl, idx) => {
                            const catId = catEl.getAttribute('data-category-id');
                            const cat = state.categories.find(c => c.id === catId);
                            if (cat) cat.order = idx;
                        });
                    });
                }
            }));
        });

        document.querySelectorAll('.task-list').forEach(el => {
            this._sortableInstances.push(new Sortable(el, {
                ...commonOptions,
                handle: '.item-actions .drag-handle',
                draggable: '.task-item',
                onStart: (evt) => {
                    if (evt.fallback) {
                        const width = evt.item.getBoundingClientRect().width;
                        evt.fallback.style.width = width + 'px';
                    }
                },
                onEnd: (evt) => {
                    const taskEls = Array.from(el.querySelectorAll(':scope > .task-item'));
                    this.modifyStateAndRender('Reordered tasks', () => {
                        taskEls.forEach((taskEl, idx) => {
                            const taskId = taskEl.getAttribute('data-task-id');
                            const task = state.tasks.find(t => t.id === taskId);
                            if (task) task.order = idx;
                        });
                    });
                }
            }));
        });
    },

    renderTabs() {
        this.sortDays(state.days);
        const days = state.days || [];

        this.tabsContainer.innerHTML = days
            .map(day => {
                const isActive = day.id === state.activeDayId;
                const canEdit = permissionLevel !== 'read';
                const dateTooltip = (canEdit && isActive) ? "Click current tab to edit date" : "";

                return `
                <div class="tab ${isActive ? 'active' : ''}" onclick="app.handleTabClick('${day.id}')">
                    <div style="position: relative; display: flex; flex-direction: column; align-items: flex-start; width: 100%; cursor: ${canEdit ? 'pointer' : 'default'};" ${dateTooltip ? `title="${dateTooltip}"` : ''}>
                        <span style="font-weight: 600;">${day.name}</span>
                        <div style="display: flex; align-items: center; gap: 0.25rem; width: 100%;">
                            <span style="font-size: 0.8em; opacity: 0.8; text-decoration: ${canEdit && isActive ? 'underline dotted' : 'none'};">${day.date || 'Set date'}</span>
                            ${canEdit ? `<input type="date" id="date-picker-${day.id}" value="${day.rawDate || ''}" style="visibility: hidden; position: absolute; width: 0; height: 0;" onchange="app.updateDayDate('${day.id}', this.value)" onclick="event.stopPropagation()">` : ''}
                        </div>
                    </div>
                    ${canEdit ? `<span class="material-icons-round delete-icon" onclick="app.promptDelete('day', '${day.id}', event)">close</span>` : ''}
                </div>
            `;
            }).join('');
    },

    renderEvents() {
        const events = state.events || [];
        const isSearching = !!(this.searchQuery && this.searchQuery.trim().length > 0);
        const q = isSearching ? this.searchQuery.trim().toLowerCase() : '';
        const filterType = this.searchFilterType || 'all';

        let activeEvents;

        if (isSearching) {
            // Search across ALL events on ALL dates/days
            activeEvents = events.filter(event => {
                const evTitleMatch = (filterType === 'all' || filterType === 'events') && event.title.toLowerCase().includes(q);
                const matchingCats = (state.categories || []).filter(c => {
                    if (c.eventId !== event.id) return false;
                    const catTitleMatch = (filterType === 'all' || filterType === 'categories') && c.title.toLowerCase().includes(q);
                    const hasMatchingTasks = (state.tasks || []).some(t => {
                        if (t.categoryId !== c.id) return false;
                        if (filterType === 'events' || filterType === 'categories') return false;
                        return t.text.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q));
                    });
                    if (filterType === 'tasks') return hasMatchingTasks;
                    if (filterType === 'categories') return catTitleMatch;
                    return catTitleMatch || hasMatchingTasks || evTitleMatch;
                });
                return evTitleMatch || matchingCats.length > 0;
            });

            // Sort events by day order first, then by event order
            const daysMap = new Map((state.days || []).map((d, idx) => [d.id, d.order !== undefined ? d.order : idx]));
            activeEvents.sort((a, b) => {
                const dayOrderA = daysMap.get(a.dayId) ?? 999;
                const dayOrderB = daysMap.get(b.dayId) ?? 999;
                if (dayOrderA !== dayOrderB) return dayOrderA - dayOrderB;
                return (a.order || 0) - (b.order || 0);
            });

            if (activeEvents.length === 0) {
                this.eventsList.innerHTML = `
                    <div style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
                        <span class="material-icons-round" style="font-size: 2.8rem; color: var(--text-muted); opacity: 0.6; margin-bottom: 0.5rem;">search_off</span>
                        <p style="font-size: 1rem; font-weight: 600; color: var(--text-main); margin-bottom: 0.25rem;">No results found for "${this.searchQuery}"</p>
                        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">Try searching for a different keyword or filter type.</p>
                        <button class="btn-ghost btn-small" onclick="app.clearSearch()" style="border: 1px solid rgba(255,255,255,0.15);">Clear Search</button>
                    </div>
                `;
                return;
            }
        } else {
            activeEvents = events
                .filter(e => e.dayId === state.activeDayId)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
        }

        if (activeEvents.length === 0) {
            this.eventsList.innerHTML = `<p style="text-align: center; color: var(--text-muted);">No events for this day yet.</p>`;
            return;
        }

        // Find the last consecutive completed event from the top for timeline fill
        let lastCompletedIndex = -1;
        for (let i = 0; i < activeEvents.length; i++) {
            if (activeEvents[i].completed) lastCompletedIndex = i;
            else break;
        }

        let activeEventIndex = lastCompletedIndex + 1;
        if (activeEventIndex >= activeEvents.length && activeEvents.length > 0) {
            activeEventIndex = activeEvents.length - 1;
        }

        this.eventsList.innerHTML = activeEvents.map((event, index) => {
            let categories = (state.categories || [])
                .filter(c => c.eventId === event.id)
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

            if (isSearching) {
                const evTitleMatch = (filterType === 'all' || filterType === 'events') && event.title.toLowerCase().includes(q);
                categories = categories.filter(cat => {
                    const catTitleMatch = (filterType === 'all' || filterType === 'categories') && cat.title.toLowerCase().includes(q);
                    const hasMatchingTasks = (state.tasks || []).some(t => {
                        if (t.categoryId !== cat.id) return false;
                        if (filterType === 'events' || filterType === 'categories') return false;
                        return t.text.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q));
                    });
                    if (filterType === 'tasks') return hasMatchingTasks;
                    if (filterType === 'categories') return catTitleMatch;
                    return catTitleMatch || hasMatchingTasks || evTitleMatch;
                });
            }
            
            const isFilled = index <= lastCompletedIndex;
            const canEdit = permissionLevel !== 'read';
            const isEventExpanded = isSearching ? true : (this.localExpandedEvents && this.localExpandedEvents[event.id] !== undefined
                ? this.localExpandedEvents[event.id]
                : (event.collapsed === false));

            const visibleCategories = categories;
            const moreCategoriesBadge = '';

            const detailsHTML = visibleCategories.map(cat => {
                let taskItems = (state.tasks || [])
                    .filter(t => t.categoryId === cat.id)
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

                if (isSearching) {
                    const evTitleMatch = (filterType === 'all' || filterType === 'events') && event.title.toLowerCase().includes(q);
                    const catTitleMatch = (filterType === 'all' || filterType === 'categories') && cat.title.toLowerCase().includes(q);
                    taskItems = taskItems.filter(task => {
                        const taskMatch = (filterType === 'all' || filterType === 'tasks') && (task.text.toLowerCase().includes(q) || (task.description && task.description.toLowerCase().includes(q)));
                        if (filterType === 'tasks') return taskMatch;
                        return taskMatch || catTitleMatch || evTitleMatch;
                    });
                }

                const isCatExpanded = isSearching ? true : (this.localExpandedCategories && this.localExpandedCategories[cat.id] !== undefined
                    ? this.localExpandedCategories[cat.id]
                    : (!cat.collapsed));

                const displayCatTitle = isSearching ? this.highlightMatch(cat.title, q) : cat.title;

                const dayObj = (state.days || []).find(d => d.id === event.dayId);
                const dayLabel = dayObj 
                    ? ((dayObj.name && dayObj.date) ? `${dayObj.name}, ${dayObj.date}` : (dayObj.name || dayObj.date || dayObj.rawDate || 'Day'))
                    : 'Day';

                const catDayBadgeHTML = (isSearching && dayObj) ? `
                    <span class="search-day-badge" onclick="event.stopPropagation(); app.jumpToItem('${dayObj.id}', '${event.id}', '${cat.id}')" title="Jump to ${dayLabel}">
                        <span class="material-icons-round" style="font-size: 0.8rem;">calendar_today</span> ${dayLabel}
                    </span>
                ` : '';

                return `
                    <div class="category ${isCatExpanded ? '' : 'collapsed'}" data-category-id="${cat.id}">
                        <div class="category-header" onclick="app.toggleCategory('${cat.id}', event)" style="display: flex; align-items: center; gap: 0.35rem; cursor: pointer;">
                            <div class="category-title-group" style="display: flex; align-items: center; gap: 0.5rem; flex:1; min-width:0;">
                                <span class="material-icons-round category-icon">folder_open</span>
                                <h4 id="cat-title-${cat.id}" class="category-title" ${canEdit ? 'contenteditable="true"' : ''} 
                                    onfocus="app.onFieldFocus('cat-title-${cat.id}')"
                                    onblur="app.onFieldBlur('Edited category title')"
                                    oninput="app.editCategoryTitle('${cat.id}', this.innerText)" 
                                    onkeydown="app.preventEnter(event)" ${canEdit ? 'onclick="event.stopPropagation()"' : ''} spellcheck="false">${displayCatTitle}</h4>
                                ${taskItems.length > 0 ? `<span class="category-meta">${taskItems.length} task${taskItems.length !== 1 ? 's' : ''}</span>` : ''}
                                ${catDayBadgeHTML}
                            </div>
                            <div style="display:flex; align-items:center; gap: 0.25rem; flex-shrink:0;">
                                ${canEdit ? `<span class="material-icons-round drag-handle" style="color: var(--text-muted); cursor: grab; font-size: 1.1rem;" onclick="event.stopPropagation()">drag_indicator</span>
                                <span class="material-icons-round delete-icon" onclick="event.stopPropagation(); app.deleteCategory('${cat.id}', event)">close</span>` : ''}
                                <span class="material-icons-round expand-icon" style="font-size: 1.1rem;">expand_more</span>
                            </div>
                        </div>
                        
                        <div class="category-content-wrapper">
                            <div class="category-content-inner">
                                <div class="category-content">
                                    ${taskItems.length > 0 ? `
                                    <ul class="task-list" data-category-id="${cat.id}">
                                        ${taskItems.map(task => {
                                            const isTaskExpanded = !this.expandedTasks || this.expandedTasks[task.id] !== false;
                                            const displayTaskText = isSearching ? this.highlightMatch(task.text, q) : task.text;
                                            const displayTaskDesc = (isSearching && task.description) ? this.highlightMatch(task.description, q) : task.description;

                                            const taskDayBadgeHTML = (isSearching && dayObj) ? `
                                                <span class="search-day-badge" onclick="event.stopPropagation(); app.jumpToItem('${dayObj.id}', '${event.id}', '${cat.id}', '${task.id}')" title="Jump to ${dayLabel}">
                                                    <span class="material-icons-round" style="font-size: 0.8rem;">calendar_today</span> ${dayLabel}
                                                </span>
                                            ` : '';

                                            return `
                                            <li class="task-item ${task.completed ? 'completed' : ''}" data-task-id="${task.id}">
                                                <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} ${!canEdit ? 'disabled' : ''} onchange="app.toggleTask('${task.id}')" onclick="event.stopPropagation()">
                                                <div class="task-content" style="cursor: pointer;" onclick="event.stopPropagation(); app.toggleTaskExpand('${task.id}', event)" title="Click to ${isTaskExpanded ? 'collapse' : 'expand'} task details">
                                                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.35rem;">
                                                        <span id="task-text-${task.id}" class="task-text" ${canEdit ? 'contenteditable="true"' : ''} 
                                                            onfocus="app.onFieldFocus('task-text-${task.id}')"
                                                            onblur="app.onFieldBlur('Edited task text')"
                                                            oninput="app.editTaskText('${task.id}', this.innerText)" 
                                                            onkeydown="app.preventEnter(event)" ${canEdit ? 'onclick="event.stopPropagation()"' : ''} spellcheck="false">${displayTaskText}</span>
                                                        ${task.description ? `<span class="material-icons-round task-expand-icon" style="font-size: 1.1rem; color: var(--text-muted); transition: transform 0.2s; ${isTaskExpanded ? 'transform: rotate(180deg);' : ''}">expand_more</span>` : ''}
                                                    </div>
                                                    ${task.description ? `<div class="task-description ${isTaskExpanded ? 'expanded' : 'collapsed'}" style="${isTaskExpanded ? 'display: block; margin-top: 0.25rem;' : 'display: none;'}" spellcheck="false">${displayTaskDesc}</div>` : ''}
                                                </div>
                                                <div class="item-actions" style="display: flex; align-items: center; gap: 0.25rem; flex-shrink:0;">
                                                    ${taskDayBadgeHTML}
                                                    ${canEdit ? `
                                                    <span class="material-icons-round edit-icon" style="font-size: 1.05rem; color: var(--text-muted); cursor: pointer;" title="Edit task" onclick="event.stopPropagation(); app.openTaskModal('${task.id}')">edit</span>
                                                    <span class="material-icons-round drag-handle" style="font-size: 1.1rem; color: var(--text-muted); cursor: grab;" onclick="event.stopPropagation()">drag_indicator</span>
                                                    <span class="material-icons-round delete-icon" style="font-size: 1rem;" onclick="event.stopPropagation(); app.deleteTask('${task.id}', event)">close</span>
                                                    ` : `
                                                    <span class="material-icons-round info-icon" style="font-size: 1.05rem; color: var(--text-muted); cursor: pointer;" title="View task details" onclick="event.stopPropagation(); app.openTaskModal('${task.id}')">info</span>
                                                    `}
                                                </div>
                                            </li>
                                            `;
                                        }).join('')}
                                    </ul>
                                    ` : `<div class="no-tasks-msg" style="padding: 0.5rem 0.85rem; font-size: 0.82rem; color: var(--text-muted); font-style: italic;">No tasks in this category yet.</div>`}
                                    ${canEdit ? `
                                    <div style="padding: 0.35rem 0.85rem 0.5rem;">
                                        <button class="btn-ghost" style="padding: 0.3rem 0.5rem; display: flex; align-items: center; gap: 0.4rem; color: var(--primary); font-size: 0.85rem; opacity: 0.85;" onclick="app.openTaskModal(null, '${cat.id}')" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0.85'">
                                            <span class="material-icons-round" style="font-size: 1rem;">add</span> Add task
                                        </button>
                                    </div>` : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            const addCategoryFormHTML = (isEventExpanded && canEdit) ? `
                <div class="inline-input-container" style="${categories.length > 0 ? 'margin-top: 1rem; padding-top: 0.75rem; border-top: 1px dashed rgba(255,255,255,0.1);' : 'margin-top: 0.5rem;'}">
                    <input type="text" class="inline-input category-input" id="new-cat-${event.id}" placeholder="+ Add a category (e.g. Logistics)..." onblur="app.saveCategory('${event.id}')" onkeydown="if(event.key==='Enter'||event.key==='Escape') { event.preventDefault(); this.blur(); }">
                    <button class="btn-icon" onmousedown="event.preventDefault(); app.saveCategory('${event.id}')" title="Save Category">
                        <span class="material-icons-round" style="font-size: 1.2rem;">check_circle</span>
                    </button>
                </div>
            ` : '';

            const openQuestions = (state.questions || []).filter(q => q.eventId === event.id && !q.answered);
            const questionBadgeHTML = openQuestions.length > 0 ? `
                <span class="event-question-badge" onclick="app.openQuestionSpaceModal('${event.id}', true); event.stopPropagation();" title="${openQuestions.length} open query(s) - click to view unresolved">
                    <span class="material-icons-round" style="font-size: 0.85rem;">help_outline</span> ${openQuestions.length}
                </span>
            ` : '';

            const isLast = (index === activeEvents.length - 1);
            const insertGapHTML = (canEdit && !isLast) ? `
                <div class="timeline-gap-insert" title="Insert timeline event here" onclick="event.stopPropagation(); app.promptAddEvent('${event.id}');">
                    <div class="timeline-insert-btn">
                        <span class="material-icons-round">add</span>
                    </div>
                </div>
            ` : '';

            const displayEventTitle = isSearching ? this.highlightMatch(event.title, q) : event.title;

            const dayObj = (state.days || []).find(d => d.id === event.dayId);
            const dayLabel = dayObj 
                ? ((dayObj.name && dayObj.date) ? `${dayObj.name}, ${dayObj.date}` : (dayObj.name || dayObj.date || dayObj.rawDate || 'Day'))
                : 'Day';
            const dayBadgeHTML = (isSearching && dayObj) ? `
                <span class="search-day-badge" onclick="event.stopPropagation(); app.jumpToItem('${dayObj.id}', '${event.id}')" title="Jump to ${dayLabel}">
                    <span class="material-icons-round" style="font-size: 0.8rem;">calendar_today</span> ${dayLabel}
                </span>
            ` : '';

            return `
                <div class="event-block ${isEventExpanded ? 'expanded' : ''} ${event.completed ? 'completed' : ''} ${isFilled ? 'completed-line' : ''} ${index === activeEventIndex ? 'active-event' : ''}" data-event-id="${event.id}" onclick="app.toggleEvent('${event.id}', event)">
                    <div class="event-header">
                        <div class="event-title-group">
                            <input type="checkbox" class="task-checkbox" ${event.completed ? 'checked' : ''} ${!canEdit ? 'disabled' : ''} onchange="app.toggleEventComplete('${event.id}')" onclick="event.stopPropagation()">
                            <h3 id="event-title-${event.id}" class="event-title" ${canEdit ? 'contenteditable="true"' : ''} 
                                onfocus="app.onFieldFocus('event-title-${event.id}')"
                                onblur="app.onFieldBlur('Edited event title')"
                                oninput="app.editEventTitle('${event.id}', this.innerText)" 
                                onkeydown="app.preventEnter(event)" ${canEdit ? 'onclick="event.stopPropagation()"' : ''} spellcheck="false">${displayEventTitle}</h3>
                            ${dayBadgeHTML}
                        </div>
                        <div style="display:flex; align-items:center; gap: 0.35rem; flex-shrink:0;">
                            ${questionBadgeHTML}
                            <span class="material-icons-round question-icon" style="color: var(--text-muted); cursor: pointer; font-size: 1.1rem;" title="Post query for this event" onclick="app.openQuestionSpaceModal('${event.id}', false); event.stopPropagation();" onmouseenter="this.style.color='#f39c12'" onmouseleave="this.style.color='var(--text-muted)'">help_outline</span>
                            ${canEdit ? `<span class="material-icons-round drag-handle" style="color: var(--text-muted); cursor: grab;" onclick="event.stopPropagation()">drag_indicator</span>
                            <span class="material-icons-round delete-icon" onclick="app.promptDelete('event', '${event.id}', event)">close</span>` : ''}
                            <span class="material-icons-round expand-icon">expand_more</span>
                        </div>
                    </div>
                    
                    <div class="event-categories-wrapper" onclick="event.stopPropagation()">
                        <div class="event-details" data-event-id="${event.id}">
                            ${detailsHTML}
                            ${moreCategoriesBadge}
                            ${addCategoryFormHTML}
                        </div>
                    </div>
                    ${insertGapHTML}
                </div>
            `;
        }).join('');
    }
};

window.app = app;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-add-day').onclick = () => app.promptAddDay();
    document.getElementById('btn-add-event').onclick = () => app.promptAddEvent();
    document.getElementById('btn-save-day').onclick = () => app.saveDay();
    document.getElementById('btn-save-event').onclick = () => app.saveEvent();
    
    // Title & Search bindings
    const titleInput = document.getElementById('app-title-input');
    if (titleInput) {
        titleInput.addEventListener('focus', () => app.onFieldFocus('app-title-input'));
        titleInput.addEventListener('blur', () => app.onFieldBlur('Changed timeline title'));
        titleInput.addEventListener('input', (e) => app.handleTitleInput(e.target.value));
        titleInput.addEventListener('keydown', app.preventEnter);
    }

    const searchInput = document.getElementById('app-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => app.handleSearchInput(e.target.value));
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                app.clearSearch();
                searchInput.blur();
            }
        });
    }
    
    app.init();
});

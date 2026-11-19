import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { User, AzureAuthConfig } from '../types';
import * as api from './api';

export const DEFAULT_DIRECT_ADMIN_USER: User = {
    id: 'H583623',
    name: 'Aguilera, Alberto',
    email: 'ALBERTOISAAC.AGUILERA@Honeywell.com',
    department: 'Honeywell Aerospace Engineering',
    jobTitle: 'Lead ECN Administrator (Modo Directo)',
    tenantId: '96ece526-9c7d-48b0-8daf-8b93c90a5d18',
    hid: 'H583623',
    role: 'admin',
    isSuperAdmin: true,
    accessLevel: 'Acceso Total (Azure Deshabilitado)',
};

interface AuthContextType {
    currentUser: User | null;
    isAuthenticated: boolean;
    isSuperAdmin: boolean;
    isLoading: boolean;
    isAuthEnabled: boolean;
    azureConfig: AzureAuthConfig | null;
    loginWithAzure: () => Promise<User | null>;
    loginWithServerToServer: (config?: { clientId?: string; clientSecret?: string; tenantId?: string }) => Promise<User | null>;
    loginWithCorporateEmail: (params: { emailOrId: string; name?: string; department?: string; jobTitle?: string; customConfig?: any }) => Promise<User>;
    logout: () => Promise<void>;
    refreshUser: () => Promise<void>;
    refreshConfig: () => Promise<AzureAuthConfig | null>;
    directLogin: (userData: Partial<User>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOCAL_STORAGE_USER_KEY = 'ecn_azure_current_user';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const isEnvAuthEnabled = (
        typeof process !== 'undefined' && (
            process.env.AZURE_AUTH_ENABLED === 'true' || 
            process.env.ENABLE_AZURE_AUTH === 'true' ||
            process.env.AZURE_AUTH_ENABLED === '1'
        )
    );

    const azureConfigRef = useRef<AzureAuthConfig | null>(null);
    const [azureConfig, setAzureConfig] = useState<AzureAuthConfig | null>(null);
    const isAuthEnabled = azureConfig?.authEnabled !== undefined ? !!azureConfig.authEnabled : isEnvAuthEnabled;

    const [currentUser, setCurrentUser] = useState<User | null>(() => {
        try {
            const saved = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
            if (saved) return JSON.parse(saved);
        } catch {}
        // If Azure Auth is not enabled in environment, default directly to the admin user
        return isEnvAuthEnabled ? null : DEFAULT_DIRECT_ADMIN_USER;
    });

    const [isLoading, setIsLoading] = useState<boolean>(true);

    const refreshConfig = useCallback(async () => {
        try {
            const config = await api.getAzureAuthConfig();
            azureConfigRef.current = config;
            setAzureConfig(config);
            return config;
        } catch (error) {
            console.error('[Auth] Failed to load Azure AD config:', error);
            return null;
        }
    }, []);

    const refreshUser = useCallback(async (activeConfig?: AzureAuthConfig | null) => {
        try {
            const { user } = await api.getCurrentUser();
            const configToCheck = activeConfig !== undefined ? activeConfig : azureConfigRef.current;
            const authCurrentlyEnabled = configToCheck?.authEnabled !== undefined 
                ? !!configToCheck.authEnabled 
                : isEnvAuthEnabled;

            if (user) {
                setCurrentUser(user);
                try {
                    localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(user));
                } catch (_) {}
            } else {
                if (!authCurrentlyEnabled) {
                    // When Azure Auth is disabled, default directly to the full Administrator
                    setCurrentUser(DEFAULT_DIRECT_ADMIN_USER);
                    try {
                        localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(DEFAULT_DIRECT_ADMIN_USER));
                    } catch (_) {}
                } else {
                    const saved = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
                    if (saved) {
                        try {
                            setCurrentUser(JSON.parse(saved));
                        } catch {
                            setCurrentUser(null);
                        }
                    } else {
                        setCurrentUser(null);
                    }
                }
            }
        } catch (error) {
            console.warn('[Auth] Session check failed, relying on fallback state:', error);
            setCurrentUser(prev => {
                if (prev) return prev;
                return !isEnvAuthEnabled ? DEFAULT_DIRECT_ADMIN_USER : null;
            });
        }
    }, [isEnvAuthEnabled]);

    useEffect(() => {
        let isMounted = true;
        const init = async () => {
            setIsLoading(true);
            try {
                const loadedConfig = await refreshConfig();
                if (!isMounted) return;
                await refreshUser(loadedConfig);
            } catch (err) {
                console.error('[Auth] Initialization error:', err);
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        };
        init();
        return () => {
            isMounted = false;
        };
    }, [refreshConfig, refreshUser]);

    // Listen for messages from popup window when user finishes Microsoft login
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // Validate message structure
            if (event.data?.type === 'AZURE_AUTH_SUCCESS') {
                const user = event.data.user as User;
                if (user) {
                    setCurrentUser(user);
                    try {
                        localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(user));
                    } catch (_) {}
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const loginWithAzure = useCallback(async (): Promise<User | null> => {
        try {
            // 1. Request OAuth authorization URL from server
            const { url, redirectUri } = await api.getAzureAuthUrl();
            if (!url) {
                throw new Error('No se pudo generar la URL de autenticación de Azure.');
            }

            console.log('[Auth] Opening Azure AD Login Popup:', { url, redirectUri });

            // 2. Open Microsoft login page in a centered popup window
            const width = 600;
            const height = 700;
            const left = window.screenX + (window.outerWidth - width) / 2;
            const top = window.screenY + (window.outerHeight - height) / 2;

            const popup = window.open(
                url,
                'azure_login_popup',
                `width=${width},height=${height},left=${left},top=${top},status=no,toolbar=no,menubar=no,location=no,resizable=yes,scrollbars=yes`
            );

            if (!popup) {
                alert('El navegador bloqueó la ventana emergente de inicio de sesión. Por favor permita popups para este sitio.');
                return null;
            }

            // Return a promise that resolves when postMessage arrives or popup closes
            return new Promise((resolve) => {
                let resolved = false;

                const messageListener = (event: MessageEvent) => {
                    if (event.data?.type === 'AZURE_AUTH_SUCCESS') {
                        resolved = true;
                        window.removeEventListener('message', messageListener);
                        clearInterval(checkPopupInterval);
                        const authedUser = event.data.user as User;
                        setCurrentUser(authedUser);
                        localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(authedUser));
                        resolve(authedUser);
                    } else if (event.data?.type === 'AZURE_AUTH_ERROR') {
                        resolved = true;
                        window.removeEventListener('message', messageListener);
                        clearInterval(checkPopupInterval);
                        alert(`Error al iniciar sesión con Azure: ${event.data.error || 'Error desconocido'}`);
                        resolve(null);
                    }
                };

                window.addEventListener('message', messageListener);

                // Polling to detect if user closed the popup without logging in
                const checkPopupInterval = setInterval(() => {
                    if (popup.closed) {
                        clearInterval(checkPopupInterval);
                        window.removeEventListener('message', messageListener);
                        if (!resolved) {
                            // Check if cookie was set or session was established
                            refreshUser();
                            resolve(null);
                        }
                    }
                }, 800);
            });
        } catch (error: any) {
            console.error('[Auth] Azure login failed:', error);
            alert(`Error al iniciar sesión con Azure AD: ${error.message || error}`);
            return null;
        }
    }, [refreshUser]);

    const loginWithServerToServer = useCallback(async (config?: { clientId?: string; clientSecret?: string; tenantId?: string }): Promise<User | null> => {
        try {
            const res = await api.connectServerToServer(config);
            if (res.success && res.user) {
                setCurrentUser(res.user);
                localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(res.user));
                return res.user;
            }
            throw new Error(res.message || 'No se pudo autenticar como aplicación Server-to-Server.');
        } catch (error: any) {
            console.error('[Auth] Server-to-server login failed:', error);
            throw error;
        }
    }, []);

    const loginWithCorporateEmail = useCallback(async (params: { emailOrId: string; name?: string; department?: string; jobTitle?: string; customConfig?: any }): Promise<User> => {
        try {
            const res = await api.loginWithAzureServerToServerUser(params);
            if (res.success && res.user) {
                setCurrentUser(res.user);
                localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(res.user));
                return res.user;
            }
            throw new Error(res.message || 'Error al autenticar usuario con Microsoft Graph.');
        } catch (error: any) {
            console.error('[Auth] Corporate Graph login failed:', error);
            throw error;
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.logoutAzure();
        } catch (e) {
            console.warn('[Auth] Server logout notification error:', e);
        }
        localStorage.removeItem(LOCAL_STORAGE_USER_KEY);
        if (isAuthEnabled) {
            setCurrentUser(null);
        } else {
            setCurrentUser(DEFAULT_DIRECT_ADMIN_USER);
        }
    }, [isAuthEnabled]);

    const directLogin = useCallback(async (userData: Partial<User>) => {
        try {
            const res = await api.testAzureLoginDirect(userData);
            if (res.user) {
                setCurrentUser(res.user);
                localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(res.user));
            }
        } catch (e) {
            // Fallback direct local assignment
            const fallbackUser: User = {
                id: userData.id || 'AZURE_USER_' + Date.now(),
                name: userData.name || 'Usuario Honeywell',
                email: userData.email || 'usuario@honeywell.com',
                department: userData.department || 'Engineering',
                photo: userData.photo,
                jobTitle: userData.jobTitle || 'ECN Specialist',
                tenantId: azureConfigRef.current?.tenantId || '96ece526-9c7d-48b0-8daf-8b93c90a5d18',
            };
            setCurrentUser(fallbackUser);
            try {
                localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(fallbackUser));
            } catch (_) {}
        }
    }, []);

    const isSuperAdmin = !!(
        currentUser && (
            currentUser.isSuperAdmin ||
            currentUser.role === 'admin' ||
            (currentUser.hid && currentUser.hid.toUpperCase() === 'H583623') ||
            (currentUser.id && currentUser.id.toUpperCase() === 'H583623') ||
            ((currentUser as any).mailNickname && (currentUser as any).mailNickname.toUpperCase() === 'H583623') ||
            (currentUser.email && currentUser.email.toLowerCase() === 'beto22mex@gmail.com') ||
            (currentUser.email && currentUser.email.toUpperCase().includes('ALBERTOISAAC.AGUILERA')) ||
            (currentUser.email && currentUser.email.toUpperCase().includes('H583623'))
        )
    );

    return (
        <AuthContext.Provider
            value={{
                currentUser,
                isAuthenticated: !!currentUser,
                isSuperAdmin,
                isLoading,
                isAuthEnabled,
                azureConfig,
                loginWithAzure,
                loginWithServerToServer,
                loginWithCorporateEmail,
                logout,
                refreshUser,
                refreshConfig,
                directLogin,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
};

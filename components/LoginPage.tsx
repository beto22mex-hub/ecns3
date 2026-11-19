import React, { useState } from 'react';
import { useAuth } from '../services/authContext';
import * as api from '../services/api';

interface LoginPageProps {
    onLoginSuccess?: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
    const { loginWithAzure } = useAuth();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSsoLogin = async () => {
        setError(null);
        setIsLoading(true);
        try {
            const user = await loginWithAzure();
            if (user && onLoginSuccess) {
                onLoginSuccess();
            }
        } catch (err: any) {
            console.error('[LoginPage] Error en Microsoft SSO:', err);
            setError(err?.message || 'Ocurrió un error al iniciar sesión con Microsoft SSO.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleDirectRedirect = async () => {
        try {
            setIsLoading(true);
            const { url } = await api.getAzureAuthUrl();
            if (url) {
                window.location.href = url;
            }
        } catch (err: any) {
            setError('No se pudo generar la URL de Microsoft Entra ID.');
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center px-4 py-8 relative overflow-hidden">
            {/* Ambient Background Glows */}
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none"></div>
            <div className="absolute bottom-10 right-10 w-72 h-72 bg-sky-600/10 rounded-full blur-3xl pointer-events-none"></div>

            <div className="w-full max-w-md z-10 space-y-6">
                {/* Brand Header */}
                <div className="text-center space-y-2">
                    <div className="inline-flex items-center justify-center gap-2 mb-1">
                        <span className="font-black text-3xl tracking-tight text-red-600">Honeywell</span>
                        <span className="border-l border-slate-700 h-6 mx-1"></span>
                        <span className="text-slate-400 font-medium text-sm">ECN Manager</span>
                    </div>
                    <h1 className="text-xl font-bold text-white tracking-tight">
                        Portal de Acceso Corporativo
                    </h1>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto">
                        Inicie sesión con su cuenta institucional de Honeywell mediante el servicio de identidad federada Microsoft Entra ID.
                    </p>
                </div>

                {/* Login Card */}
                <div className="bg-slate-900/95 border border-slate-800 rounded-2xl p-7 shadow-2xl backdrop-blur-sm space-y-6">
                    
                    {/* Entra ID SSO Verified Badge */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 text-xs">
                        <div className="flex items-center gap-2.5">
                            <div className="w-5 h-5 grid grid-cols-2 gap-0.5 shrink-0">
                                <div className="bg-[#f25022] rounded-[1px]"></div>
                                <div className="bg-[#7fba00] rounded-[1px]"></div>
                                <div className="bg-[#00a4ef] rounded-[1px]"></div>
                                <div className="bg-[#ffb900] rounded-[1px]"></div>
                            </div>
                            <div>
                                <div className="text-slate-200 font-semibold text-xs leading-none">Microsoft Entra ID</div>
                                <div className="text-[10px] text-slate-400 mt-0.5">Single Sign-On Corporativo</div>
                            </div>
                        </div>
                        <span className="text-[10px] font-mono bg-emerald-950/80 text-emerald-300 border border-emerald-800/60 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            OpenID SSO
                        </span>
                    </div>

                    {/* Informative Instructions */}
                    <div className="text-center px-1">
                        <p className="text-xs text-slate-300 leading-relaxed">
                            Haga clic en el botón inferior para identificarse interactivamente con su cuenta corporativa de <strong className="text-white">Honeywell</strong>.
                        </p>
                    </div>

                    {/* Error Alert */}
                    {error && (
                        <div className="p-3 bg-rose-950/50 border border-rose-800 rounded-xl text-xs text-rose-200 flex items-start gap-2 animate-in fade-in duration-150">
                            <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <div className="flex-1">
                                <span>{error}</span>
                                <div className="mt-1">
                                    <button
                                        type="button"
                                        onClick={handleDirectRedirect}
                                        className="text-rose-300 underline font-semibold hover:text-white"
                                    >
                                        Intentar redirigir directamente aquí
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Single Interactive Microsoft SSO Action Button */}
                    <button
                        type="button"
                        onClick={handleSsoLogin}
                        disabled={isLoading}
                        id="btn-microsoft-sso-interactive"
                        className="w-full py-3.5 px-4 bg-white hover:bg-slate-100 text-slate-900 font-semibold text-sm rounded-xl shadow-lg hover:shadow-xl flex items-center justify-center gap-3 transition-all duration-150 transform active:scale-[0.99] disabled:opacity-75 disabled:cursor-not-allowed border border-slate-200"
                    >
                        {isLoading ? (
                            <>
                                <span className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin"></span>
                                <span className="text-slate-800">Iniciando sesión con Microsoft...</span>
                            </>
                        ) : (
                            <>
                                {/* Microsoft 4-Color Logo */}
                                <div className="w-4 h-4 grid grid-cols-2 gap-0.5 shrink-0">
                                    <div className="bg-[#f25022] rounded-[1px]"></div>
                                    <div className="bg-[#7fba00] rounded-[1px]"></div>
                                    <div className="bg-[#00a4ef] rounded-[1px]"></div>
                                    <div className="bg-[#ffb900] rounded-[1px]"></div>
                                </div>
                                <span className="text-slate-900 font-bold">Iniciar con Microsoft SSO Interactivo</span>
                            </>
                        )}
                    </button>

                    {/* Fallback info for blocked popups */}
                    <div className="text-center pt-2">
                        <button
                            type="button"
                            onClick={handleDirectRedirect}
                            className="text-[11px] text-slate-400 hover:text-sky-400 transition-colors"
                        >
                            ¿Problemas con ventanas emergentes? Iniciar por redirección completa
                        </button>
                    </div>
                </div>

                {/* Footer Notes */}
                <div className="text-center text-xs text-slate-500 space-y-1">
                    <p>Honeywell International Inc. • ECN Change Management System</p>
                    <p className="text-[11px] text-slate-600">Autenticación delegada segura con alcance OpenID Connect (openid, profile, email)</p>
                </div>
            </div>
        </div>
    );
};



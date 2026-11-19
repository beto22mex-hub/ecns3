import React, { useState } from 'react';
import { useAuth } from '../services/authContext';
import * as api from '../services/api';
import { Modal, Button } from './ui';

interface CorporateLoginModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess?: () => void;
}

export const CorporateLoginModal: React.FC<CorporateLoginModalProps> = ({ isOpen, onClose, onSuccess }) => {
    const { loginWithAzure } = useAuth();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleSsoLogin = async () => {
        setError(null);
        setIsLoading(true);
        try {
            const user = await loginWithAzure();
            if (user) {
                onClose();
                if (onSuccess) onSuccess();
            }
        } catch (err: any) {
            setError(err.message || 'Error al conectar con Microsoft SSO.');
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
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 grid grid-cols-2 gap-0.5 p-1 bg-slate-950 rounded shadow-sm shrink-0">
                        <div className="bg-[#f25022] rounded-xs"></div>
                        <div className="bg-[#7fba00] rounded-xs"></div>
                        <div className="bg-[#00a4ef] rounded-xs"></div>
                        <div className="bg-[#ffb900] rounded-xs"></div>
                    </div>
                    <div>
                        <div className="text-base font-bold text-white">Autenticación Microsoft SSO</div>
                        <div className="text-xs text-sky-400 font-normal">Microsoft Entra ID • OpenID Connect</div>
                    </div>
                </div>
            }
        >
            <div className="space-y-4 py-2">
                {/* Information Header */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-300 space-y-2">
                    <div className="font-semibold text-slate-100 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        Acceso Institucional de Honeywell
                    </div>
                    <p className="text-slate-400 leading-relaxed">
                        Para ingresar a la plataforma debe autenticarse interactivamente con su cuenta corporativa a través del servicio seguro de Microsoft.
                    </p>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="p-3 bg-rose-950/40 border border-rose-800/60 rounded-lg text-xs text-rose-300 flex items-center gap-2">
                        <svg className="w-4 h-4 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{error}</span>
                    </div>
                )}

                {/* Primary Button */}
                <button
                    type="button"
                    onClick={handleSsoLogin}
                    disabled={isLoading}
                    id="modal-btn-microsoft-sso"
                    className="w-full py-3 px-4 bg-white hover:bg-slate-100 text-slate-900 font-bold text-sm rounded-xl shadow-md flex items-center justify-center gap-2.5 transition-all active:scale-[0.99] disabled:opacity-75"
                >
                    {isLoading ? (
                        <>
                            <span className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin"></span>
                            <span>Iniciando sesión...</span>
                        </>
                    ) : (
                        <>
                            <div className="w-4 h-4 grid grid-cols-2 gap-0.5 shrink-0">
                                <div className="bg-[#f25022] rounded-[1px]"></div>
                                <div className="bg-[#7fba00] rounded-[1px]"></div>
                                <div className="bg-[#00a4ef] rounded-[1px]"></div>
                                <div className="bg-[#ffb900] rounded-[1px]"></div>
                            </div>
                            <span>Iniciar con Microsoft SSO Interactivo</span>
                        </>
                    )}
                </button>

                {/* Secondary Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-800 text-[11px]">
                    <button
                        type="button"
                        onClick={handleDirectRedirect}
                        className="text-sky-400 hover:text-sky-300 underline"
                    >
                        Redirección completa si se bloquean popups
                    </button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isLoading}
                        className="!text-xs !py-1 !px-3"
                    >
                        Cerrar
                    </Button>
                </div>
            </div>
        </Modal>
    );
};


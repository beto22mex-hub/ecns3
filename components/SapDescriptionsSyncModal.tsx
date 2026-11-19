import React, { useState, useEffect, useRef } from 'react';
import { Modal, Button } from './ui';
import * as api from '../services/api';

interface SapDescriptionsSyncModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUpdated?: () => void;
    initialEcn?: string;
    setNotification?: (n: { message: string; type: 'success' | 'error' } | null) => void;
}

export const SapDescriptionsSyncModal: React.FC<SapDescriptionsSyncModalProps> = ({
    isOpen,
    onClose,
    onUpdated,
    initialEcn = '',
    setNotification
}) => {
    // Tabs: 'iqs3' (direct navigation to IQS3), 'webgui' (Tampermonkey), 'paste', 'single'
    const [activeTab, setActiveTab] = useState<'iqs3' | 'webgui' | 'paste' | 'single'>('iqs3');
    
    // Global pending state
    const [missingEcns, setMissingEcns] = useState<string[]>([]);
    const [isLoadingMissing, setIsLoadingMissing] = useState(false);
    const [copiedList, setCopiedList] = useState(false);

    // Tab 1: IQS3 Direct Extraction State
    const [iqs3Scope, setIqs3Scope] = useState<'mask' | 'all'>('mask');
    const [iqs3Mask, setIqs3Mask] = useState<string>('2026-*');
    const [iqs3MatchingEcns, setIqs3MatchingEcns] = useState<string[]>([]);
    const [isLoadingIqs3Matches, setIsLoadingIqs3Matches] = useState<boolean>(false);
    const [isExecutingIqs3, setIsExecutingIqs3] = useState<boolean>(false);
    const [iqs3Result, setIqs3Result] = useState<{
        success?: boolean;
        message?: string;
        updatedCount?: number;
        totalFound?: number;
        downloadVbsUrl?: string;
        downloadBatUrl?: string;
        webguiUrl?: string;
        error?: string;
        mode?: string;
    } | null>(null);

    // Tab 2: Paste mode state
    const [pasteContent, setPasteContent] = useState('');
    const [isSavingPaste, setIsSavingPaste] = useState(false);
    const [pasteFeedback, setPasteFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    // Tab 3: Single/Pattern state
    const [ecnInput, setEcnInput] = useState(initialEcn || '2026-*');
    const [manualDescription, setManualDescription] = useState('');
    const [isProcessingSingle, setIsProcessingSingle] = useState(false);
    const [singleFeedback, setSingleFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    // Script copy state
    const [showScriptDetails, setShowScriptDetails] = useState(true);
    const [scriptCopied, setScriptCopied] = useState(false);

    const pollingIntervalRef = useRef<any>(null);

    // Fetch pending descriptions on mount or when modal opens
    const fetchPendingDescriptions = async (showLoading = true) => {
        if (showLoading) setIsLoadingMissing(true);
        try {
            const res = await api.updateMissingSapDescriptions();
            if (res.success && Array.isArray(res.missingEcns)) {
                setMissingEcns(res.missingEcns);
            }
        } catch (err) {
            console.warn('Error fetching pending ECNs:', err);
        } finally {
            if (showLoading) setIsLoadingMissing(false);
        }
    };

    // Refresh IQS3 matching ECNs from database
    const refreshIqs3Matches = async () => {
        setIsLoadingIqs3Matches(true);
        try {
            const res = await api.syncIqs3Descriptions({
                mask: iqs3Scope === 'mask' ? iqs3Mask.trim() : undefined,
                allExisting: iqs3Scope === 'all'
            });
            if (res && Array.isArray(res.ecns)) {
                setIqs3MatchingEcns(res.ecns);
            }
        } catch (e) {
            console.warn('Error refreshing IQS3 matches:', e);
        } finally {
            setIsLoadingIqs3Matches(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            if (initialEcn) {
                setEcnInput(initialEcn);
                setActiveTab('single');
            } else {
                setActiveTab('iqs3');
            }
            fetchPendingDescriptions(true);
            refreshIqs3Matches();

            // Set up polling while modal is open to detect syncs in real-time
            pollingIntervalRef.current = setInterval(() => {
                fetchPendingDescriptions(false);
            }, 4000);
        } else {
            if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current);
            }
        }

        return () => {
            if (pollingIntervalRef.current) {
                clearInterval(pollingIntervalRef.current);
            }
        };
    }, [isOpen, initialEcn]);

    // Re-query IQS3 matches when scope or mask changes
    useEffect(() => {
        if (isOpen && activeTab === 'iqs3') {
            const timeout = setTimeout(() => {
                refreshIqs3Matches();
            }, 300);
            return () => clearTimeout(timeout);
        }
    }, [iqs3Scope, iqs3Mask, activeTab, isOpen]);

    const handleCopyPendingList = () => {
        if (missingEcns.length === 0) return;
        navigator.clipboard.writeText(missingEcns.join('\n'));
        setCopiedList(true);
        setTimeout(() => setCopiedList(false), 2500);
    };

    // Execute IQS3 Direct Navigation & Extraction
    const handleExecuteIqs3 = async () => {
        setIsExecutingIqs3(true);
        setIqs3Result(null);
        try {
            const res = await api.syncIqs3Descriptions({
                mask: iqs3Scope === 'mask' ? iqs3Mask.trim() : undefined,
                allExisting: iqs3Scope === 'all'
            });
            setIqs3Result(res);

            if (res.success) {
                if (res.updatedCount && res.updatedCount > 0) {
                    fetchPendingDescriptions(false);
                    refreshIqs3Matches();
                    if (onUpdated) onUpdated();
                    if (setNotification) {
                        setNotification({
                            type: 'success',
                            message: `¡Éxito! Se actualizaron ${res.updatedCount} descripciones directamente desde la transacción IQS3.`
                        });
                    }
                } else if (res.mode === 'cloud_ready') {
                    if (setNotification) {
                        setNotification({
                            type: 'success',
                            message: `Se prepararon ${res.totalFound} ECN(s) para extraer descripciones en IQS3.`
                        });
                    }
                }
            } else {
                if (setNotification) {
                    setNotification({
                        type: 'error',
                        message: res.error || 'No se pudo completar la extracción en IQS3.'
                    });
                }
            }
        } catch (err: any) {
            setIqs3Result({
                success: false,
                error: err.message || 'Error de conexión con el servidor.'
            });
        } finally {
            setIsExecutingIqs3(false);
        }
    };

    const handleSavePasteData = async () => {
        if (!pasteContent.trim()) {
            setPasteFeedback({ type: 'error', message: 'Por favor pegue los datos antes de guardar.' });
            return;
        }

        setIsSavingPaste(true);
        setPasteFeedback(null);
        try {
            const res = await api.updateMissingSapDescriptions({ rawText: pasteContent });
            if (res.success && res.updatedCount > 0) {
                setPasteFeedback({
                    type: 'success',
                    message: `¡Éxito! Se actualizaron ${res.updatedCount} descripciones de ECNs desde el texto de SAP WebGUI.`
                });
                setPasteContent('');
                fetchPendingDescriptions(false);
                refreshIqs3Matches();
                if (onUpdated) onUpdated();
                if (setNotification) {
                    setNotification({
                        message: `Se actualizaron ${res.updatedCount} descripciones de ECNs en base de datos.`,
                        type: 'success'
                    });
                }
            } else if (res.success && res.updatedCount === 0) {
                setPasteFeedback({
                    type: 'error',
                    message: 'No se reconocieron filas válidas con formato [ECN, Descripción]. Verifique el contenido pegado.'
                });
            } else {
                setPasteFeedback({
                    type: 'error',
                    message: res.error || 'Error al procesar los datos pegados.'
                });
            }
        } catch (err: any) {
            setPasteFeedback({
                type: 'error',
                message: err.message || 'Error de conexión con el servidor.'
            });
        } finally {
            setIsSavingPaste(false);
        }
    };

    const handleExecuteSingleOrPattern = async () => {
        if (!ecnInput.trim()) {
            setSingleFeedback({ type: 'error', message: 'Ingrese un número de ECN o una máscara de búsqueda.' });
            return;
        }

        setIsProcessingSingle(true);
        setSingleFeedback(null);
        try {
            let res;
            if (manualDescription.trim()) {
                res = await api.updateMissingSapDescriptions({
                    ecnId: ecnInput.trim(),
                    description: manualDescription.trim()
                });
            } else {
                res = await api.updateMissingSapDescriptions({
                    pattern: ecnInput.trim()
                });
            }

            if (res.success) {
                const count = res.updatedCount || (res.missingEcns ? res.missingEcns.length : 0);
                setSingleFeedback({
                    type: 'success',
                    message: res.message || `Procesado correctamente (${count} coincidentes).`
                });
                if (res.updatedCount > 0) {
                    setManualDescription('');
                    fetchPendingDescriptions(false);
                    refreshIqs3Matches();
                    if (onUpdated) onUpdated();
                }
            } else {
                setSingleFeedback({
                    type: 'error',
                    message: res.error || 'No se pudo completar la operación.'
                });
            }
        } catch (err: any) {
            setSingleFeedback({
                type: 'error',
                message: err.message || 'Error de conexión con el servidor.'
            });
        } finally {
            setIsProcessingSingle(false);
        }
    };

    // Calculate preview lines from paste
    const previewParsedCount = (() => {
        if (!pasteContent.trim()) return 0;
        const lines = pasteContent.trim().split(/\r?\n/);
        let count = 0;
        for (const line of lines) {
            const parts = line.split(/\t| {2,}|;|\|/).map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2 && parts[0].length >= 4) count++;
        }
        return count;
    })();

    // Tampermonkey UserScript with direct IQS3 Auto-Scanner integration
    const tampermonkeyScript = `// ==UserScript==
// @name         SAP WebGUI - Sincronizador Directo IQS3 (I1S3) & Descripciones ECN
// @namespace    http://tampermonkey.net/
// @version      7.9
// @description  Navega a IQS3 en SAP WebGUI, ingresa el número de aviso de cada ECN, maneja ventanas emergentes de información, selección asistida con botones morados (Aviso, Desc, Atrás), retorno garantizado F3 / /nIQS3, extrae y actualiza la descripción en ECN Manager
// @author       Honeywell ECN Manager
// @match        https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      *
// ==/UserScript==

(function() {
    'use strict';
    const API_BASE = 'http://localhost:3000/api/sap';

    // 1. Registro y visualización en consola interna
    function logMsg(msg, isSuccess) {
        console.log('[ECN IQS3]', msg);
        const box = document.getElementById('ecn-iqs3-log-content');
        if (box) {
            const time = new Date().toLocaleTimeString();
            const p = document.createElement('div');
            p.style.cssText = 'margin-bottom:3px;font-family:monospace;font-size:11px;color:' + (isSuccess ? '#4ade80' : '#cbd5e1') + ';';
            p.innerText = '[' + time + '] ' + msg;
            box.appendChild(p);
            box.scrollTop = box.scrollHeight;
        }
    }

    // 2. Obtener todos los documentos (ventana principal + todos los iframes/frames de SAP ITS)
    function getAllDocs(win) {
        win = win || window;
        const docs = [];
        try {
            if (win.document) docs.push(win.document);
        } catch(e) {}

        function scan(currentWin) {
            try {
                const iframes = currentWin.document ? currentWin.document.querySelectorAll('iframe, frame') : [];
                for (let i = 0; i < iframes.length; i++) {
                    try {
                        const cWin = iframes[i].contentWindow;
                        if (cWin && cWin !== currentWin && cWin.document && !docs.includes(cWin.document)) {
                            docs.push(cWin.document);
                            scan(cWin);
                        }
                    } catch(e) {}
                }
            } catch(e) {}
        }
        scan(win);
        return docs;
    }

    // 3. Validar si un campo es editable y visible
    function isUsableInput(el) {
        if (!el || el.tagName !== 'INPUT') return false;
        if (el.type === 'hidden' || el.type === 'button' || el.type === 'submit' || el.type === 'image') return false;
        if (el.disabled || el.readOnly) return false;
        try {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch(e) {
            return true;
        }
    }

    // 4. Localizar el campo de número de Aviso (QMNUM / RIWO00-QMNUM) en IQS3
    function findNotificationInput() {
        // Selector personalizado memorizado con el botón morado
        const customSelector = localStorage.getItem('ecn_iqs3_custom_notif_selector');
        if (customSelector) {
            for (const doc of getAllDocs()) {
                try {
                    const el = doc.querySelector(customSelector);
                    if (el && isUsableInput(el)) return { el, doc, method: 'custom-selector: ' + customSelector };
                } catch(e) {}
            }
        }

        const docs = getAllDocs();
        for (const doc of docs) {
            // A. Por atributos directos (QMNUM, Aviso, Notification)
            const selectors = [
                'input[name*="QMNUM" i]',
                'input[id*="QMNUM" i]',
                'input[ct*="QMNUM" i]',
                'input[ti*="QMNUM" i]',
                'input[title*="Aviso" i]',
                'input[title*="Notification" i]',
                'input[aria-label*="Aviso" i]',
                'input[aria-label*="Notification" i]'
            ];
            for (const sel of selectors) {
                const matches = doc.querySelectorAll(sel);
                for (const el of matches) {
                    if (isUsableInput(el)) return { el, doc, method: sel };
                }
            }

            // B. Por etiqueta asociada con texto "Aviso" o "Notification"
            const labels = Array.from(doc.querySelectorAll('label, span, td, div')).filter(l => {
                const t = (l.innerText || l.textContent || '').trim().toLowerCase();
                return t === 'aviso' || t === 'aviso:' || t === 'notification' || t === 'notification:';
            });
            for (const lbl of labels) {
                const forId = lbl.getAttribute('for');
                if (forId) {
                    const inp = doc.getElementById(forId);
                    if (inp && isUsableInput(inp)) return { el: inp, doc, method: 'label-for' };
                }
                const container = lbl.closest('tr, div, table');
                if (container) {
                    const inps = Array.from(container.querySelectorAll('input'));
                    const target = inps.find(isUsableInput);
                    if (target) return { el: target, doc, method: 'label-container' };
                }
            }

            // C. Fallback en pantalla de acceso inicial de IQS3: primer input editable que no sea okcode (comando)
            const allInputs = Array.from(doc.querySelectorAll('input'));
            const candidate = allInputs.find(inp => {
                if (!isUsableInput(inp)) return false;
                const str = ((inp.id || '') + ' ' + (inp.name || '') + ' ' + (inp.className || '') + ' ' + (inp.title || '')).toLowerCase();
                if (str.includes('okcode') || str.includes('cmd') || str.includes('command') || str.includes('transac')) return false;
                return true;
            });
            if (candidate) return { el: candidate, doc, method: 'first-visible-input' };
        }
        return null;
    }

    // 5. Localizar el botón de Continuar / Enter (Palomita verde / btn[0])
    function findContinueButton(targetDoc) {
        const docs = targetDoc ? [targetDoc, ...getAllDocs()] : getAllDocs();
        const selectors = [
            '[id*="btn[0]"]',
            '[id*="M0:37::btn[0]"]',
            '[id*="M0:50::btn[0]"]',
            '[id$="btn[0]"]',
            '[title*="Continuar" i]',
            '[title*="Continue" i]',
            '[title*="Enter" i]',
            '[title*="Entrar" i]',
            '[title*="Ejecutar" i]',
            '.urBtnStd[title*="Enter" i]',
            '.urBtnStd[title*="Continuar" i]'
        ];
        for (const doc of docs) {
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (btn) return { btn, doc };
            }
        }
        return null;
    }

    // 6. Localizar el botón de Regresar / Atrás (F3 / btn[3])
    function findBackButton(targetDoc) {
        const customBack = localStorage.getItem('ecn_iqs3_custom_back_selector');
        if (customBack) {
            for (const doc of getAllDocs()) {
                try {
                    const el = doc.querySelector(customBack);
                    if (el) return { btn: el, doc, method: 'custom-back: ' + customBack };
                } catch(e) {}
            }
        }

        const docs = targetDoc ? [targetDoc, ...getAllDocs()] : getAllDocs();
        const selectors = [
            '[id*="btn[3]"]',
            '[id$="btn[3]"]',
            '[id*="wnd[0]/tbar[0]/btn[3]"]',
            '[id*="M0:37::btn[3]"]',
            '[id*="M0:50::btn[3]"]',
            '[title*="Atrás" i]',
            '[title*="Back" i]',
            '[title*="Volver" i]',
            '[title*="F3" i]',
            '.urBtnStd[title*="Atrás" i]',
            '.urBtnStd[title*="Back" i]'
        ];
        for (const doc of docs) {
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (btn) return { btn, doc, method: sel };
            }
        }
        return null;
    }

    // 7. Localizar el texto breve / descripción del aviso en IQS3 (QMTXT)
    function findDescription() {
        const customSelector = localStorage.getItem('ecn_iqs3_custom_desc_selector');
        if (customSelector) {
            for (const doc of getAllDocs()) {
                try {
                    const el = doc.querySelector(customSelector);
                    if (el) {
                        const val = (el.value || el.innerText || el.textContent || '').trim();
                        if (val.length >= 2) return { text: val, el, doc, method: 'custom-desc: ' + customSelector };
                    }
                } catch(e) {}
            }
        }

        const docs = getAllDocs();
        for (const doc of docs) {
            // A. Por atributos directos QMTXT
            const selectors = [
                'input[name*="QMTXT" i]',
                'input[id*="QMTXT" i]',
                'input[ct*="QMTXT" i]',
                'input[ti*="QMTXT" i]',
                'input[title*="Texto breve" i]',
                'input[title*="Short text" i]',
                'textarea[name*="QMTXT" i]',
                'textarea[id*="QMTXT" i]',
                'span[id*="QMTXT" i]',
                'div[id*="QMTXT" i]',
                '[ct*="QMTXT" i]'
            ];
            for (const sel of selectors) {
                const matches = doc.querySelectorAll(sel);
                for (const el of matches) {
                    const val = (el.value || el.innerText || el.textContent || '').trim();
                    if (val.length >= 2 && !val.toLowerCase().includes('texto breve') && !val.toLowerCase().includes('short text')) {
                        return { text: val, el, doc, method: sel };
                    }
                }
            }

            // B. Por proximidad a etiqueta "Texto breve" o "Short text"
            const labels = Array.from(doc.querySelectorAll('label, span, td, div')).filter(l => {
                const t = (l.innerText || l.textContent || '').trim().toLowerCase();
                return t.includes('texto breve') || t.includes('short text');
            });
            for (const lbl of labels) {
                const container = lbl.closest('tr, div, table');
                if (container) {
                    const items = Array.from(container.querySelectorAll('input, textarea, span.urTxtStd, div'));
                    for (const item of items) {
                        if (item === lbl) continue;
                        const val = (item.value || item.innerText || item.textContent || '').trim();
                        if (val.length >= 2 && !val.toLowerCase().includes('texto breve') && !val.toLowerCase().includes('short text')) {
                            return { text: val, el: item, doc, method: 'adjacent-label' };
                        }
                    }
                }
            }
        }
        return null;
    }

    // 8. Detectar si hay un mensaje de error en la barra de estado de SAP
    function findSapStatusError() {
        const docs = getAllDocs();
        for (const doc of docs) {
            const bar = doc.querySelector('[id*="msg" i], [id*="status" i], [class*="urMsgBar" i], [class*="lsMessage" i], .urMsgBarErr');
            if (bar) {
                const txt = (bar.innerText || bar.textContent || '').trim();
                if (txt && (txt.toLowerCase().includes('no existe') || txt.toLowerCase().includes('does not exist') || txt.toLowerCase().includes('error'))) {
                    return txt;
                }
            }
        }
        return null;
    }

    // 8.1 Auto-descartar ventanas emergentes de "Información" / advertencia (ej. "No existe el texto del catálogo de acciones")
    function dismissSapPopupIfPresent() {
        const docs = getAllDocs();
        for (const doc of docs) {
            // A. Detectar contenedores modales wnd[1], urPW, dialog
            const dialogs = doc.querySelectorAll('[id*="wnd[1]"], [role="dialog"], .urPW, [class*="Dialog" i], [class*="PopupWindow" i], div[title*="Información" i]');
            for (const dlg of dialogs) {
                const rect = dlg.getBoundingClientRect();
                if (rect.width > 30 && rect.height > 20) {
                    // Buscar botón con palomita verde / Continuar / btn[0] dentro de la ventana modal
                    const okBtn = dlg.querySelector('[id*="btn[0]"], [title*="Continuar" i], [title*="Tomar" i], [title*="Enter" i], [title*="OK" i], .urBtnStd, button');
                    if (okBtn) {
                        try {
                            okBtn.style.outline = '3px solid #22c55e';
                            okBtn.click();
                            logMsg('✓ Ventana emergente SAP ("Información") detectada. Clic en botón [✓] Continuar.', true);
                            return true;
                        } catch(e) {}
                    }

                    // Enviar tecla Enter directamente a la ventana emergente
                    try {
                        const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
                        dlg.dispatchEvent(enterEvt);
                        doc.dispatchEvent(enterEvt);
                        logMsg('✓ Ventana emergente detectada. Enviado [Enter] para descartar.', true);
                        return true;
                    } catch(e) {}
                }
            }

            // B. Búsqueda directa del botón verde de la ventana modal secundaria wnd[1]
            const wnd1Btn = doc.querySelector('[id*="wnd[1]"][id*="btn[0]"], [id*="wnd[1]"] [id*="btn[0]"], [id*="wnd[1]"] .urBtnStd, [id*="wnd[1]"] button');
            if (wnd1Btn) {
                try {
                    wnd1Btn.click();
                    logMsg('✓ Ventana emergente wnd[1] confirmada mediante btn[0].', true);
                    return true;
                } catch(e) {}
            }
        }
        return false;
    }

    // 9. Escribir valor de forma compatible con SAP Unified Rendering
    function setSapInputValue(input, val) {
        input.focus();
        try { input.select(); } catch(e) {}

        const proto = window.HTMLInputElement ? window.HTMLInputElement.prototype : Object.getPrototypeOf(input);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
            setter.call(input, val);
        } else {
            input.value = val;
        }
        input.setAttribute('value', val);

        // Resaltado visual en pantalla (borde verde)
        try {
            input.style.border = '2px solid #22c55e';
            input.style.backgroundColor = '#f0fdf4';
            setTimeout(() => {
                try {
                    input.style.border = '';
                    input.style.backgroundColor = '';
                } catch(e) {}
            }, 1200);
        } catch(e) {}

        // Disparar secuencia completa de eventos que escucha SAP WebGUI
        ['focus', 'input', 'keydown', 'keypress', 'keyup', 'change', 'blur'].forEach(evtType => {
            try {
                input.dispatchEvent(new Event(evtType, { bubbles: true, cancelable: true }));
            } catch(e) {}
        });
    }

    // 10. Enviar pantalla inicial (Continuar / Enter)
    function submitInitialScreen(input, targetDoc) {
        const btnObj = findContinueButton(targetDoc);
        if (btnObj && btnObj.btn) {
            try {
                btnObj.btn.style.outline = '3px solid #22c55e';
                btnObj.btn.click();
            } catch(e) {}
            logMsg('Clic en botón Continuar (' + (btnObj.btn.id || btnObj.btn.title || 'btn[0]') + ')');
        }

        // También emitir evento de tecla Enter
        try {
            const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
            input.dispatchEvent(enterEvt);
            if (targetDoc) targetDoc.dispatchEvent(enterEvt);
        } catch(e) {}
    }

    // Disparar clic completo de SAP con mouseup, mousedown y click
    function triggerSapClick(el) {
        if (!el) return;
        try { el.focus(); } catch(e) {}
        ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click'].forEach(evt => {
            try {
                el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
            } catch(e) {}
        });
        try { el.click(); } catch(e) {}
    }

    // Disparar evento de teclado F3 (código 114) para regresar en SAP
    function triggerF3Key(doc) {
        const d = doc || document;
        const evtDown = new KeyboardEvent('keydown', { key: 'F3', code: 'F3', keyCode: 114, which: 114, bubbles: true });
        const evtUp = new KeyboardEvent('keyup', { key: 'F3', code: 'F3', keyCode: 114, which: 114, bubbles: true });
        try { d.dispatchEvent(evtDown); d.dispatchEvent(evtUp); } catch(e) {}
        if (d.activeElement) {
            try { d.activeElement.dispatchEvent(evtDown); d.activeElement.dispatchEvent(evtUp); } catch(e) {}
        }
    }

    // Localizar campo de código de comando / OKCode de SAP WebGUI
    function findOkCodeInput() {
        for (const doc of getAllDocs()) {
            const sel = [
                'input[id*="okcode" i]',
                'input[name*="okcode" i]',
                'input[id*="cmd" i]',
                '#urOkCode',
                'input[title*="Código de transacción" i]',
                'input[title*="Transaction code" i]',
                'input[title*="Command" i]'
            ];
            for (const s of sel) {
                const el = doc.querySelector(s);
                if (el && isUsableInput(el)) return { el, doc };
            }
        }
        return null;
    }

    // Ejecutar acción de regresar a la pantalla inicial de IQS3 por múltiples vías
    function triggerBackAction(targetDoc) {
        // A. Selector personalizado fijado con botón morado
        const customBack = localStorage.getItem('ecn_iqs3_custom_back_selector');
        if (customBack) {
            for (const doc of getAllDocs()) {
                try {
                    const el = doc.querySelector(customBack);
                    if (el) {
                        triggerSapClick(el);
                        logMsg('Clic en botón Atrás memorizado (' + customBack + ')');
                        return;
                    }
                } catch(e) {}
            }
        }

        // B. Botón estándar Atrás / Back / F3 / btn[3]
        const backObj = findBackButton(targetDoc);
        if (backObj && backObj.btn) {
            try { backObj.btn.style.outline = '3px solid #f59e0b'; } catch(e) {}
            triggerSapClick(backObj.btn);
            logMsg('Clic en botón Atrás (' + (backObj.btn.id || backObj.btn.title || 'btn[3]') + ')');
        }

        // C. Emular pulsación de tecla F3 (114)
        for (const doc of getAllDocs()) {
            triggerF3Key(doc);
        }

        // D. Si hay barra de transacciones (OKCode), ingresar /nIQS3
        const okInput = findOkCodeInput();
        if (okInput) {
            try {
                setSapInputValue(okInput.el, '/nIQS3');
                const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
                okInput.el.dispatchEvent(enterEvt);
                okInput.doc.dispatchEvent(enterEvt);
                logMsg('Comando /nIQS3 enviado en barra de comandos SAP.');
            } catch(e) {}
        }
    }

    // Guardián de transición: regresa a la pantalla inicial y SOLO continúa cuando se confirma que ya salimos de la pantalla de detalle
    function returnToInitialScreenAndContinue(onSuccess) {
        logMsg('Regresando a pantalla inicial de IQS3...');
        triggerBackAction();

        let attempts = 0;
        const checkInterval = setInterval(() => {
            attempts++;
            dismissSapPopupIfPresent();

            const currentDesc = findDescription();
            const notifInput = findNotificationInput();

            // Si ya no existe la descripción y tenemos el campo de aviso en pantalla inicial:
            if (!currentDesc && notifInput) {
                clearInterval(checkInterval);
                logMsg('✓ Pantalla inicial de IQS3 confirmada. Listo para siguiente ECN.', true);
                setTimeout(onSuccess, 500);
                return;
            }

            // Reintentar si sigue en pantalla de detalle tras 1.6s o 3.2s
            if (attempts === 4 || attempts === 8) {
                logMsg('Reintentando regresar (F3 / btn[3] / Comando /nIQS3)...');
                triggerBackAction();
            }

            // Si tras 5.5s no regresa, forzar recarga limpia de la transacción IQS3
            if (attempts >= 14) {
                clearInterval(checkInterval);
                logMsg('⚠️ No regresó tras 5.5s. Recargando transacción IQS3 limpia...');
                window.location.href = 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3';
            }
        }, 400);
    }

    // 11. Diagnosticar e inspeccionar campos en la pantalla actual
    function diagnoseScreen() {
        const docs = getAllDocs();
        let report = '🔎 REPORTE DE DETECCIÓN SAP WEBGUI (IQS3):\\n\\n';
        report += '• Documentos/Marcos inspeccionados: ' + docs.length + '\\n';

        const notifObj = findNotificationInput();
        if (notifObj) {
            report += '✅ Campo de AVISO detectado:\\n';
            report += '   - Selector: ' + notifObj.method + '\\n';
            report += '   - ID: ' + (notifObj.el.id || '(sin id)') + '\\n';
            report += '   - Name: ' + (notifObj.el.name || '(sin name)') + '\\n';
            report += '   - Valor actual: "' + notifObj.el.value + '"\\n';
            try { notifObj.el.style.outline = '3px solid #22c55e'; } catch(e) {}
        } else {
            report += '❌ Campo de AVISO: No encontrado en este momento.\\n';
        }

        const contBtn = findContinueButton();
        if (contBtn) {
            report += '✅ Botón Continuar (btn[0]): Detectado (' + (contBtn.btn.id || contBtn.btn.title || 'OK') + ')\\n';
            try { contBtn.btn.style.outline = '3px solid #3b82f6'; } catch(e) {}
        } else {
            report += '⚠️ Botón Continuar: No detectado.\\n';
        }

        const descObj = findDescription();
        if (descObj) {
            report += '✅ Campo de DESCRIPCIÓN detectado:\\n';
            report += '   - Texto: "' + descObj.text + '"\\n';
            report += '   - Método: ' + descObj.method + '\\n';
            try { if (descObj.el) descObj.el.style.outline = '3px solid #a855f7'; } catch(e) {}
        } else {
            report += 'ℹ️ Descripción: No presente (normal si está en la pantalla inicial de IQS3).\\n';
        }

        const backBtn = findBackButton();
        if (backBtn) {
            report += '✅ Botón Atrás / Regresar (F3 / btn[3]): Detectado (' + (backBtn.btn.id || backBtn.btn.title || backBtn.method || 'F3') + ')\\n';
            try { backBtn.btn.style.outline = '3px solid #f59e0b'; } catch(e) {}
        } else {
            report += '⚠️ Botón Atrás: No detectado automáticamente (usa "🎯 Apuntar Atrás").\\n';
        }

        alert(report);
        logMsg('Diagnóstico finalizado. Aviso: ' + (notifObj ? 'SI' : 'NO') + ' | Desc: ' + (descObj ? 'SI' : 'NO') + ' | Atrás: ' + (backBtn ? 'SI' : 'NO'));
    }

    // 12. Probar ingreso de 1 ECN de prueba
    function testSingleEcn() {
        const defaultEcn = '2026-956';
        const ecn = prompt('Ingrese el número de ECN / Aviso a probar en IQS3:', defaultEcn);
        if (!ecn) return;

        logMsg('Probando ingreso de ECN: ' + ecn);
        const notifObj = findNotificationInput();
        if (!notifObj) {
            alert('❌ No se encontró el campo de aviso en la pantalla actual. Asegúrese de estar en la transacción IQS3.');
            logMsg('Error: Campo de aviso no encontrado.');
            return;
        }

        setSapInputValue(notifObj.el, ecn.trim());
        logMsg('Valor escrito en campo: ' + ecn.trim() + ' (' + notifObj.method + ')');

        setTimeout(() => {
            submitInitialScreen(notifObj.el, notifObj.doc);
            logMsg('Enviado Continuar (Enter). Verificando apertura...');

            // Esperar y leer descripción
            let attempts = 0;
            const poller = setInterval(() => {
                attempts++;

                // Descartar automáticamente diálogo modal de Información ("No existe el texto del catálogo de acciones", etc.)
                dismissSapPopupIfPresent();

                const descObj = findDescription();
                if (descObj) {
                    clearInterval(poller);
                    logMsg('✓ ¡Éxito! Descripción leída: "' + descObj.text + '"', true);
                    alert('🎉 ¡Extracción exitosa!\\n\\nECN: ' + ecn + '\\nDescripción: ' + descObj.text + '\\n\\nPuedes pulsar "🔙 Probar Regresar (F3)" para verificar el retorno.');
                } else if (attempts >= 16) {
                    clearInterval(poller);
                    const errMsg = findSapStatusError();
                    logMsg('Resultado: ' + (errMsg || 'No se obtuvo descripción tras 6.4 segundos.'));
                }
            }, 400);
        }, 300);
    }

    // Modo Asistido: Hacer clic directamente sobre el campo real en SAP para memorizarlo
    function startPickerMode(targetType) {
        let label = '';
        if (targetType === 'notif') label = 'NÚMERO DE AVISO (donde escribes el ECN)';
        else if (targetType === 'desc') label = 'DESCRIPCIÓN / TEXTO BREVE';
        else if (targetType === 'back') label = 'BOTÓN ATRÁS / REGRESAR (Flecha verde o botón Atrás de SAP)';

        alert('👉 MODO APUNTADOR ACTIVO:\\n\\nHaz clic directamente sobre el ' + label + ' en la pantalla de SAP.\\nEl script guardará su identificador exacto.');

        const docs = getAllDocs();
        function onClickCapture(e) {
            e.preventDefault();
            e.stopPropagation();

            const target = e.target;
            const id = target.id ? '#' + CSS.escape(target.id) : '';
            const name = target.getAttribute('name') ? '[name="' + target.getAttribute('name') + '"]' : '';
            const sel = id || name || (target.tagName.toLowerCase() + (target.className ? '.' + target.className.split(' ')[0] : ''));

            if (targetType === 'notif') {
                localStorage.setItem('ecn_iqs3_custom_notif_selector', sel);
                logMsg('🎯 Campo de Aviso fijado: ' + sel, true);
                alert('✅ ¡Campo de Aviso guardado exitosamente!\\nSelector: ' + sel + '\\n\\nAhora pulsa "🧪 Probar 1" para verificar el ingreso.');
            } else if (targetType === 'desc') {
                localStorage.setItem('ecn_iqs3_custom_desc_selector', sel);
                logMsg('🎯 Campo de Descripción fijado: ' + sel, true);
                alert('✅ ¡Campo de Descripción guardado exitosamente!\\nSelector: ' + sel);
            } else if (targetType === 'back') {
                localStorage.setItem('ecn_iqs3_custom_back_selector', sel);
                logMsg('🎯 Botón Atrás fijado: ' + sel, true);
                alert('✅ ¡Botón Atrás guardado exitosamente!\\nSelector: ' + sel + '\\n\\nAhora el auto-scan usará este botón para regresar.');
            }

            docs.forEach(d => d.removeEventListener('click', onClickCapture, true));
        }

        docs.forEach(d => d.addEventListener('click', onClickCapture, true));
    }

    // 13. Barra de control persistente en SAP WebGUI
    function injectControlBar() {
        const existingBar = document.getElementById('ecn-iqs3-control-bar');
        if (existingBar) {
            // Si la barra existente ya cuenta con el botón de Apuntar Atrás, no recrearla
            if (document.getElementById('btn-ecn-iqs3-pick-back')) return;
            // Si es una versión vieja (v7.8) sin el botón, removerla para inyectar la versión v7.9 actualizada
            existingBar.remove();
        }

        const bar = document.createElement('div');
        bar.id = 'ecn-iqs3-control-bar';
        bar.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:999999;background:#0f172a;color:#fff;padding:12px 16px;border-radius:12px;font-family:sans-serif;font-size:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);border:1px solid #334155;display:flex;flex-direction:column;gap:8px;width:390px;max-width:92vw;';

        const savedMask = localStorage.getItem('ecn_iqs3_filter_mask') || '2026-*';
        const isRunning = sessionStorage.getItem('ecn_iqs3_running') === 'true';

        bar.innerHTML = \`
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <div style="display:flex;align-items:center;gap:6px;">
                    <strong style="color:#38bdf8;font-size:13px;">⚡ ECN Manager IQS3</strong>
                    <span style="font-size:10px;background:#1e293b;color:#38bdf8;padding:2px 6px;border-radius:4px;font-weight:bold;border:1px solid #0284c7;">v7.9</span>
                </div>
                <span id="ecn-iqs3-status" style="font-size:11px;font-weight:bold;color:\${isRunning ? '#fbbf24' : '#94a3b8'};">
                    \${isRunning ? 'En ejecución...' : 'Listo'}
                </span>
            </div>

            <div style="font-size:11px;color:#cbd5e1;line-height:1.3;">
                Ingresa cada ECN en <strong>IQS3 (I1S3)</strong>, extrae la descripción del aviso y regresa automáticamente.
            </div>

            <div style="display:flex;align-items:center;gap:6px;">
                <label style="font-size:11px;color:#94a3b8;white-space:nowrap;">Máscara:</label>
                <input id="ecn-iqs3-mask-input" type="text" value="\${savedMask}" placeholder="ej. 2026-*, *" style="flex:1;background:#1e293b;border:1px solid #475569;color:#fff;padding:4px 8px;border-radius:6px;font-size:11px;font-family:monospace;" />
            </div>

            <div style="display:flex;gap:5px;flex-wrap:wrap;">
                <button id="btn-ecn-iqs3-scan" style="flex:1;background:#2563eb;color:#fff;border:none;padding:7px 10px;border-radius:6px;font-weight:bold;cursor:pointer;font-size:11px;white-space:nowrap;">
                    🚀 Iniciar Auto-Scan
                </button>
                <button id="btn-ecn-iqs3-stop" style="display:\${isRunning ? 'block' : 'none'};background:#dc2626;color:#fff;border:none;padding:7px 10px;border-radius:6px;font-weight:bold;cursor:pointer;font-size:11px;">
                    ⏹ Detener
                </button>
                <button id="btn-ecn-iqs3-test1" style="background:#059669;color:#fff;border:none;padding:7px 9px;border-radius:6px;font-size:11px;cursor:pointer;" title="Probar con 1 solo ECN">
                    🧪 Probar 1
                </button>
            </div>

            <!-- Botones morados para apuntar y seleccionar campos en SAP -->
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
                <button id="btn-ecn-iqs3-pick-notif" style="flex:1;min-width:105px;background:#4338ca;color:#fff;border:none;padding:7px 4px;border-radius:6px;font-weight:bold;font-size:11px;cursor:pointer;text-align:center;" title="Hacer clic en el campo donde se escribe el ECN en SAP">
                    🎯 Apuntar Aviso
                </button>
                <button id="btn-ecn-iqs3-pick-desc" style="flex:1;min-width:105px;background:#6d28d9;color:#fff;border:none;padding:7px 4px;border-radius:6px;font-weight:bold;font-size:11px;cursor:pointer;text-align:center;" title="Hacer clic en el campo de texto de descripción">
                    🎯 Apuntar Desc.
                </button>
                <button id="btn-ecn-iqs3-pick-back" style="flex:1;min-width:105px;background:#7c3aed;color:#fff;border:1px solid #c084fc;padding:7px 4px;border-radius:6px;font-weight:bold;font-size:11px;cursor:pointer;text-align:center;box-shadow:0 0 8px rgba(168,85,247,0.4);" title="Hacer clic en el botón Atrás / F3 de SAP para memorizarlo">
                    🎯 Apuntar Atrás
                </button>
            </div>

            <div style="display:flex;gap:5px;">
                <button id="btn-ecn-iqs3-test-back" style="flex:1;background:#334155;color:#e2e8f0;border:none;padding:6px 8px;border-radius:6px;font-size:10px;cursor:pointer;" title="Probar si el botón Atrás / F3 responde y regresa a la pantalla inicial">
                    🔙 Probar Regresar (F3)
                </button>
                <button id="btn-ecn-iqs3-diag" style="flex:1;background:#1e293b;border:1px solid #475569;color:#cbd5e1;padding:6px 8px;border-radius:6px;font-size:10px;cursor:pointer;" title="Diagnóstico de campos en pantalla">
                    🔍 Diagnóstico
                </button>
            </div>

            <!-- Registro en vivo colapsable -->
            <div style="border-top:1px solid #334155;padding-top:6px;margin-top:2px;">
                <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" id="ecn-iqs3-toggle-log">
                    <span style="font-size:10px;color:#94a3b8;">Registro de actividad en vivo</span>
                    <span id="ecn-iqs3-log-arrow" style="font-size:10px;color:#94a3b8;">▲</span>
                </div>
                <div id="ecn-iqs3-log-content" style="max-height:100px;overflow-y:auto;background:#020617;padding:6px 8px;border-radius:6px;margin-top:4px;border:1px solid #1e293b;">
                    <div style="color:#64748b;font-size:10px;font-style:italic;">Esperando acciones...</div>
                </div>
            </div>
        \`;

        document.body.appendChild(bar);

        // Eventos de los botones morados
        document.getElementById('btn-ecn-iqs3-pick-notif').onclick = () => startPickerMode('notif');
        document.getElementById('btn-ecn-iqs3-pick-desc').onclick = () => startPickerMode('desc');
        document.getElementById('btn-ecn-iqs3-pick-back').onclick = () => startPickerMode('back');

        // Botón Probar Retorno a Pantalla Inicial
        document.getElementById('btn-ecn-iqs3-test-back').onclick = function() {
            logMsg('Probando retorno a pantalla inicial (F3 / Atrás)...');
            triggerBackAction();
            setTimeout(() => {
                const notif = findNotificationInput();
                const desc = findDescription();
                if (!desc && notif) {
                    logMsg('✓ Éxito: Ya estás en la pantalla inicial de IQS3.', true);
                    alert('✅ ¡Retorno exitoso!\\nLa pantalla inicial de IQS3 está activa y lista.');
                } else {
                    logMsg('Aún en pantalla de detalle. Si el botón no respondió, usa "🎯 Apuntar Atrás" para seleccionarlo.');
                }
            }, 1200);
        };

        // Guardar máscara al cambiar
        const maskInput = document.getElementById('ecn-iqs3-mask-input');
        if (maskInput) {
            maskInput.onchange = function() {
                localStorage.setItem('ecn_iqs3_filter_mask', maskInput.value.trim());
            };
        }

        // Toggle del registro
        document.getElementById('ecn-iqs3-toggle-log').onclick = function() {
            const content = document.getElementById('ecn-iqs3-log-content');
            const arrow = document.getElementById('ecn-iqs3-log-arrow');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                arrow.innerText = '▲';
            } else {
                content.style.display = 'none';
                arrow.innerText = '▼';
            }
        };

        // Botón Diagnosticar
        document.getElementById('btn-ecn-iqs3-diag').onclick = diagnoseScreen;

        // Botón Probar 1 ECN
        document.getElementById('btn-ecn-iqs3-test1').onclick = testSingleEcn;

        // Botón Detener
        const stopBtn = document.getElementById('btn-ecn-iqs3-stop');
        if (stopBtn) {
            stopBtn.onclick = function() {
                sessionStorage.removeItem('ecn_iqs3_running');
                sessionStorage.removeItem('ecn_iqs3_queue');
                sessionStorage.removeItem('ecn_iqs3_index');
                stopBtn.style.display = 'none';
                document.getElementById('ecn-iqs3-status').innerText = 'Detenido';
                document.getElementById('ecn-iqs3-status').style.color = '#94a3b8';
                logMsg('Auto-scan detenido por el usuario.');
            };
        }

        // Botón Iniciar IQS3 Auto-Scan
        document.getElementById('btn-ecn-iqs3-scan').onclick = function() {
            const statusEl = document.getElementById('ecn-iqs3-status');
            const maskVal = (document.getElementById('ecn-iqs3-mask-input').value || '').trim();
            localStorage.setItem('ecn_iqs3_filter_mask', maskVal);
            statusEl.innerText = 'Consultando ECNs...';
            logMsg('Consultando ECNs en ECN Manager (máscara: ' + (maskVal || '*') + ')...');

            const queryUrl = API_BASE + '/pending-descriptions?mask=' + encodeURIComponent(maskVal) + '&all=true';

            GM_xmlhttpRequest({
                method: 'GET',
                url: queryUrl,
                onload: function(res) {
                    try {
                        const data = JSON.parse(res.responseText);
                        const ecns = data.missingEcns || data.ecns || [];
                        if (ecns.length === 0) {
                            alert('No se encontraron ECNs en la base de datos para la máscara: ' + maskVal);
                            statusEl.innerText = 'Sin ECNs';
                            logMsg('No se encontraron ECNs en la base de datos.');
                            return;
                        }

                        sessionStorage.setItem('ecn_iqs3_queue', JSON.stringify(ecns));
                        sessionStorage.setItem('ecn_iqs3_index', '0');
                        sessionStorage.setItem('ecn_iqs3_running', 'true');

                        document.getElementById('btn-ecn-iqs3-stop').style.display = 'block';
                        statusEl.innerText = '0/' + ecns.length;
                        statusEl.style.color = '#fbbf24';
                        logMsg('Iniciando escaneo de ' + ecns.length + ' ECN(s)...');

                        // Si no estamos en IQS3, navegar a IQS3
                        if (!window.location.href.includes('IQS3')) {
                            logMsg('Navegando a transacción IQS3...');
                            window.location.href = 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3';
                        } else {
                            processNextIqs3Ecn();
                        }
                    } catch(e) {
                        alert('Error al leer respuesta de ECN Manager: ' + e.message);
                    }
                },
                onerror: function() {
                    alert('❌ No se pudo comunicar con ECN Manager en localhost:3000');
                    logMsg('Error de conexión con localhost:3000');
                }
            });
        };
    }

    // 14. Procesar siguiente ECN en la cola de IQS3
    function processNextIqs3Ecn() {
        if (sessionStorage.getItem('ecn_iqs3_running') !== 'true') return;

        const queueStr = sessionStorage.getItem('ecn_iqs3_queue');
        if (!queueStr) return;
        const queue = JSON.parse(queueStr);
        let index = parseInt(sessionStorage.getItem('ecn_iqs3_index') || '0', 10);

        const statusEl = document.getElementById('ecn-iqs3-status');

        if (index >= queue.length) {
            sessionStorage.removeItem('ecn_iqs3_running');
            const stopBtn = document.getElementById('btn-ecn-iqs3-stop');
            if (stopBtn) stopBtn.style.display = 'none';
            if (statusEl) {
                statusEl.innerText = '¡Finalizado!';
                statusEl.style.color = '#4ade80';
            }
            logMsg('🎉 ¡Auto-Scan IQS3 Finalizado con éxito! Procesados: ' + queue.length, true);
            alert('🎉 ¡Extracción IQS3 Finalizada! Se procesaron ' + queue.length + ' ECN(s).');
            return;
        }

        const currentEcn = queue[index];
        if (statusEl) statusEl.innerText = (index + 1) + '/' + queue.length + ' (' + currentEcn + ')';
        logMsg('[' + (index + 1) + '/' + queue.length + '] Buscando campo Aviso para ECN: ' + currentEcn + '...');

        // Reintentos de búsqueda del campo de aviso (por si el iframe de SAP está cargando)
        let findAttempts = 0;
        const findInterval = setInterval(() => {
            findAttempts++;

            // Descartar automáticamente diálogo modal si existe
            dismissSapPopupIfPresent();

            // VERIFICACIÓN CRÍTICA: Asegurarse de NO estar en la pantalla de detalle previa
            const stillOnDesc = findDescription();
            if (stillOnDesc) {
                if (findAttempts % 2 === 0) {
                    logMsg('Aún en pantalla de detalle previa. Reintentando regresar...');
                    triggerBackAction();
                }
                return;
            }

            const notifObj = findNotificationInput();

            if (notifObj) {
                clearInterval(findInterval);
                logMsg('Campo de aviso encontrado (' + notifObj.method + '). Ingresando: ' + currentEcn);
                setSapInputValue(notifObj.el, currentEcn);

                // Esperar 350ms y enviar Continuar
                setTimeout(() => {
                    submitInitialScreen(notifObj.el, notifObj.doc);
                    logMsg('Continuar (Enter) enviado. Esperando pantalla de descripción...');

                    // Polling para esperar pantalla de descripción (hasta 6.5 segundos)
                    let pollAttempts = 0;
                    const descPoll = setInterval(() => {
                        pollAttempts++;

                        // Descartar automáticamente diálogo modal de Información ("No existe el texto del catálogo de acciones", etc.)
                        dismissSapPopupIfPresent();

                        const descObj = findDescription();

                        if (descObj) {
                            clearInterval(descPoll);
                            logMsg('✓ Descripción encontrada: "' + descObj.text + '"', true);

                            // Enviar a ECN Manager
                            GM_xmlhttpRequest({
                                method: 'POST',
                                url: API_BASE + '/update-descriptions',
                                headers: { 'Content-Type': 'application/json' },
                                data: JSON.stringify({ ecnId: currentEcn, description: descObj.text }),
                                onload: function() {
                                    logMsg('✓ Guardado en ECN Manager: ' + currentEcn, true);
                                    sessionStorage.setItem('ecn_iqs3_index', (index + 1).toString());

                                    // Regresar a la pantalla inicial de IQS3 con el guardián de confirmación
                                    setTimeout(() => {
                                        returnToInitialScreenAndContinue(processNextIqs3Ecn);
                                    }, 300);
                                },
                                onerror: function() {
                                    logMsg('⚠️ Error guardando en BD para ' + currentEcn);
                                    sessionStorage.setItem('ecn_iqs3_index', (index + 1).toString());
                                    setTimeout(() => {
                                        returnToInitialScreenAndContinue(processNextIqs3Ecn);
                                    }, 500);
                                }
                            });
                        } else if (pollAttempts >= 16) {
                            clearInterval(descPoll);
                            const sapErr = findSapStatusError();
                            logMsg('⚠️ ' + (sapErr ? 'Aviso no existe o error SAP: ' + sapErr : 'Sin respuesta tras 6s para ' + currentEcn) + '. Pasando al siguiente...');
                            sessionStorage.setItem('ecn_iqs3_index', (index + 1).toString());

                            returnToInitialScreenAndContinue(processNextIqs3Ecn);
                        }
                    }, 400);
                }, 350);

            } else if (findAttempts >= 14) {
                clearInterval(findInterval);
                logMsg('⚠️ No se encontró el campo de aviso tras 7s. Recargando IQS3...');
                window.location.href = 'https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3';
            }
        }, 500);
    }

    // 15. Iniciar al cargar la página
    window.addEventListener('load', () => {
        setTimeout(injectControlBar, 1200);
        setTimeout(processNextIqs3Ecn, 2200);
    });
    setInterval(injectControlBar, 3500);
})();`;

    const handleCopyScript = () => {
        navigator.clipboard.writeText(tampermonkeyScript);
        setScriptCopied(true);
        setTimeout(() => setScriptCopied(false), 2500);
    };

    if (!isOpen) return null;

    const currentDownloadVbsUrl = `/api/sap/download-iqs3-vbs?mask=${encodeURIComponent(iqs3Scope === 'mask' ? iqs3Mask : '')}&allExisting=${iqs3Scope === 'all' ? 'true' : 'false'}`;
    const currentDownloadBatUrl = `/api/sap/download-iqs3-bat?mask=${encodeURIComponent(iqs3Scope === 'mask' ? iqs3Mask : '')}&allExisting=${iqs3Scope === 'all' ? 'true' : 'false'}`;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Sincronizador Directo SAP - Transacción IQS3 (I1S3)"
            size="lg"
        >
            <div className="space-y-4">
                {/* Header overview status */}
                <div className="bg-gradient-to-r from-blue-50 via-indigo-50 to-slate-50 border border-blue-200 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <div className="flex items-center space-x-2">
                            <span className="flex h-2.5 w-2.5 relative">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-600"></span>
                            </span>
                            <h3 className="font-semibold text-gray-900 text-sm">
                                Extracción y Actualización Directa en Transacción IQS3 (I1S3)
                            </h3>
                        </div>
                        <p className="text-xs text-gray-600 mt-1">
                            Navega directamente a <strong>IQS3</strong> para extraer el texto oficial del aviso. <strong>Actualiza y sobrescribe</strong> la descripción en base de datos aunque ya cuente con una previa.
                        </p>
                    </div>

                    <div className="flex items-center space-x-2">
                        <div className="bg-white px-3 py-1.5 rounded-lg border border-blue-200 shadow-xs text-center">
                            <span className="text-xs text-gray-500 block">ECNs en BD</span>
                            <span className="text-base font-bold text-blue-700">
                                {isLoadingMissing ? '...' : missingEcns.length}
                            </span>
                        </div>
                        {missingEcns.length > 0 && (
                            <button
                                onClick={handleCopyPendingList}
                                className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-3 py-2 rounded-lg transition-colors shadow-xs"
                                title="Copiar lista de ECNs para buscar o validar"
                            >
                                {copiedList ? '✓ ¡Copiados!' : '📋 Copiar Lista'}
                            </button>
                        )}
                    </div>
                </div>

                {/* Tabs Navigation */}
                <div className="flex border-b border-gray-200 space-x-1">
                    <button
                        onClick={() => setActiveTab('iqs3')}
                        className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 ${
                            activeTab === 'iqs3'
                                ? 'bg-white text-blue-700 border-t-2 border-t-blue-600 border-x border-gray-200 -mb-px shadow-xs'
                                : 'text-gray-500 hover:text-gray-700 bg-gray-50'
                        }`}
                    >
                        <span>🚀 Navegación Directa IQS3 (I1S3)</span>
                        <span className="bg-blue-100 text-blue-800 text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                            {isLoadingIqs3Matches ? '...' : iqs3MatchingEcns.length}
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab('webgui')}
                        className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 ${
                            activeTab === 'webgui'
                                ? 'bg-white text-blue-700 border-t-2 border-t-blue-600 border-x border-gray-200 -mb-px shadow-xs'
                                : 'text-gray-500 hover:text-gray-700 bg-gray-50'
                        }`}
                    >
                        <span>⚡ SAP WebGUI Auto-Runner</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('paste')}
                        className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 ${
                            activeTab === 'paste'
                                ? 'bg-white text-blue-700 border-t-2 border-t-blue-600 border-x border-gray-200 -mb-px shadow-xs'
                                : 'text-gray-500 hover:text-gray-700 bg-gray-50'
                        }`}
                    >
                        <span>📋 Pegar desde SAP</span>
                        {previewParsedCount > 0 && (
                            <span className="bg-green-100 text-green-700 text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                                {previewParsedCount}
                            </span>
                        )}
                    </button>
                    <button
                        onClick={() => setActiveTab('single')}
                        className={`px-4 py-2.5 text-xs font-semibold rounded-t-lg transition-colors flex items-center space-x-2 ${
                            activeTab === 'single'
                                ? 'bg-white text-blue-700 border-t-2 border-t-blue-600 border-x border-gray-200 -mb-px shadow-xs'
                                : 'text-gray-500 hover:text-gray-700 bg-gray-50'
                        }`}
                    >
                        <span>🔍 Por ECN Individual</span>
                    </button>
                </div>

                {/* Tab 1: IQS3 (I1S3) Direct Mode */}
                {activeTab === 'iqs3' && (
                    <div className="space-y-4 py-2">
                        {/* Scope Configuration */}
                        <div className="p-4 bg-white border border-gray-200 rounded-xl shadow-xs space-y-3">
                            <label className="block text-xs font-bold text-gray-800 uppercase tracking-wider">
                                Alcance de la Extracción en Transacción IQS3:
                            </label>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <label className={`flex items-start p-3 border rounded-xl cursor-pointer transition-all ${
                                    iqs3Scope === 'mask'
                                        ? 'bg-blue-50/70 border-blue-300 ring-2 ring-blue-500/20'
                                        : 'bg-gray-50/50 border-gray-200 hover:bg-gray-50'
                                }`}>
                                    <input
                                        type="radio"
                                        name="iqs3Scope"
                                        checked={iqs3Scope === 'mask'}
                                        onChange={() => setIqs3Scope('mask')}
                                        className="mt-0.5 text-blue-600 focus:ring-blue-500 h-4 w-4"
                                    />
                                    <div className="ml-3">
                                        <span className="text-xs font-bold text-gray-900 block">Acorde a la Máscara</span>
                                        <span className="text-[11px] text-gray-500 block mt-0.5">
                                            Filtra por prefijo o patrón (ej. 2026-*, 2025-*, 100*)
                                        </span>
                                    </div>
                                </label>

                                <label className={`flex items-start p-3 border rounded-xl cursor-pointer transition-all ${
                                    iqs3Scope === 'all'
                                        ? 'bg-blue-50/70 border-blue-300 ring-2 ring-blue-500/20'
                                        : 'bg-gray-50/50 border-gray-200 hover:bg-gray-50'
                                }`}>
                                    <input
                                        type="radio"
                                        name="iqs3Scope"
                                        checked={iqs3Scope === 'all'}
                                        onChange={() => setIqs3Scope('all')}
                                        className="mt-0.5 text-blue-600 focus:ring-blue-500 h-4 w-4"
                                    />
                                    <div className="ml-3">
                                        <span className="text-xs font-bold text-gray-900 block">Cada ECN existente en BD</span>
                                        <span className="text-[11px] text-gray-500 block mt-0.5">
                                            Todos los registros registrados actualmente en la base de datos
                                        </span>
                                    </div>
                                </label>
                            </div>

                            {/* Mask Input */}
                            {iqs3Scope === 'mask' && (
                                <div className="pt-2 border-t border-gray-100 flex items-center space-x-3">
                                    <div className="flex-1">
                                        <label className="block text-xs font-semibold text-gray-700 mb-1">
                                            Máscara de ECNs:
                                        </label>
                                        <input
                                            type="text"
                                            value={iqs3Mask}
                                            onChange={e => setIqs3Mask(e.target.value)}
                                            placeholder="ej. 2026-*, 2025-*, 500000*"
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                                        />
                                    </div>
                                    <div className="pt-5">
                                        <button
                                            onClick={refreshIqs3Matches}
                                            disabled={isLoadingIqs3Matches}
                                            className="px-3 py-2 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-lg border border-gray-300 transition-colors"
                                        >
                                            {isLoadingIqs3Matches ? 'Consultando...' : '🔄 Refrescar'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Matching ECNs preview box */}
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-800">
                                    ECNs encontrados para procesar en IQS3 ({isLoadingIqs3Matches ? '...' : iqs3MatchingEcns.length}):
                                </span>
                                <span className="text-[11px] text-slate-500">
                                    Transacción destino: <strong>/nIQS3</strong> (Campo RIWO00-QMNUM)
                                </span>
                            </div>

                            {iqs3MatchingEcns.length > 0 ? (
                                <div className="max-h-24 overflow-y-auto p-2 bg-white border border-slate-200 rounded-lg flex flex-wrap gap-1.5">
                                    {iqs3MatchingEcns.slice(0, 40).map(ecn => (
                                        <span
                                            key={ecn}
                                            className="text-[11px] bg-blue-50 border border-blue-200 text-blue-800 px-2 py-0.5 rounded font-mono font-medium"
                                        >
                                            {ecn}
                                        </span>
                                    ))}
                                    {iqs3MatchingEcns.length > 40 && (
                                        <span className="text-[11px] text-gray-500 italic self-center">
                                            +{iqs3MatchingEcns.length - 40} más...
                                        </span>
                                    )}
                                </div>
                            ) : (
                                <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded-lg border border-amber-200">
                                    No se encontraron ECNs en la base de datos con la máscara actual. Ingrese otra máscara como <code className="font-mono font-bold">2026-*</code> o seleccione &quot;Cada ECN existente&quot;.
                                </p>
                            )}
                        </div>

                        {/* Result / Feedback message */}
                        {iqs3Result && (
                            <div className={`p-3 rounded-xl text-xs ${
                                iqs3Result.success
                                    ? 'bg-green-50 text-green-800 border border-green-200'
                                    : 'bg-red-50 text-red-800 border border-red-200'
                            }`}>
                                <div className="font-semibold">{iqs3Result.message || (iqs3Result.success ? 'Operación exitosa' : 'Error')}</div>
                                {iqs3Result.error && <p className="mt-1">{iqs3Result.error}</p>}
                                {iqs3Result.mode === 'cloud_ready' && (
                                    <div className="mt-2 text-green-900 bg-white/60 p-2 rounded-lg border border-green-300/50 space-y-1">
                                        <p>
                                            ✓ Listo para ejecutar con los <strong>{iqs3Result.totalFound} ECNs</strong> seleccionados. Puede usar cualquiera de las opciones de abajo:
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Action buttons panel */}
                        <div className="pt-2 border-t border-gray-200 space-y-3">
                            <div className="flex flex-wrap gap-2 justify-between items-center">
                                <div className="flex flex-wrap gap-2">
                                    {/* 1-Click SAP WebGUI direct navigation button */}
                                    <a
                                        href="https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-2 rounded-lg shadow-xs transition-all"
                                    >
                                        <span>🌐 Abrir directamente IQS3 en SAP WebGUI ↗</span>
                                    </a>

                                    {/* Standalone Windows script download */}
                                    <a
                                        href={currentDownloadVbsUrl}
                                        download="sync_iqs3_descriptions.vbs"
                                        className="inline-flex items-center space-x-1.5 bg-gray-800 hover:bg-black text-white text-xs font-semibold px-3 py-2 rounded-lg shadow-xs transition-all"
                                        title="Descargar script VBS que automatiza SAP GUI local en tu computadora Windows"
                                    >
                                        <span>💾 Descargar Automatizador Local (.vbs)</span>
                                    </a>

                                    <a
                                        href={currentDownloadBatUrl}
                                        download="sync_iqs3.bat"
                                        className="inline-flex items-center space-x-1.5 bg-slate-700 hover:bg-slate-900 text-white text-xs font-semibold px-3 py-2 rounded-lg shadow-xs transition-all"
                                        title="Descargar lanzador .bat"
                                    >
                                        <span>⚙️ Lanzador (.bat)</span>
                                    </a>
                                </div>

                                <Button
                                    variant="primary"
                                    onClick={handleExecuteIqs3}
                                    disabled={isExecutingIqs3 || iqs3MatchingEcns.length === 0}
                                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2 text-xs shadow-sm"
                                >
                                    {isExecutingIqs3 ? '⏳ Extrayendo en IQS3...' : '⚡ Iniciar Extracción Directa IQS3'}
                                </Button>
                            </div>

                            <p className="text-[11px] text-gray-500">
                                💡 <strong>Nota:</strong> Al presionar &quot;Iniciar Extracción Directa&quot;, el sistema conecta con la sesión de SAP GUI (o WebGUI), navega directamente a <code className="bg-gray-100 px-1 py-0.5 rounded text-gray-800 font-bold">/nIQS3</code>, ingresa el número de aviso de cada ECN y extrae el texto oficial del campo <code className="bg-gray-100 px-1 py-0.5 rounded text-gray-800 font-bold">VIQMEL-QMTXT</code> para actualizarlo en la base de datos.
                            </p>
                        </div>
                    </div>
                )}

                {/* Tab 2: Tampermonkey WebGUI Tab */}
                {activeTab === 'webgui' && (
                    <div className="space-y-4 py-2">
                        <div className="p-4 rounded-xl bg-blue-50/70 border border-blue-200 text-sm space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="font-semibold text-blue-950 flex items-center space-x-2">
                                    <span>🌐 Paso 1: Abrir SAP WebGUI en Transacción IQS3</span>
                                </span>
                                <a
                                    href="https://brpwas.honeywell.com/sap/bc/gui/sap/its/webgui/?~transaction=IQS3"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-xs transition-all"
                                >
                                    <span>Abrir IQS3 en brpwas.honeywell.com ↗</span>
                                </a>
                            </div>
                            <p className="text-xs text-blue-800 leading-relaxed">
                                Con el script de Tampermonkey activo, aparecerá una barra flotante en SAP WebGUI con el botón <strong>🚀 Iniciar IQS3 Auto-Scan</strong>. Al hacer clic, el script recorrerá automáticamente todos los ECNs pendientes de tu base de datos y guardará sus descripciones.
                            </p>
                        </div>

                        {/* Real-time listener indicator */}
                        <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg text-xs text-green-800">
                            <div className="flex items-center space-x-2">
                                <span className="flex h-2 w-2 relative">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-600"></span>
                                </span>
                                <span className="font-medium">Escuchando sincronizaciones automáticas desde SAP WebGUI...</span>
                            </div>
                            <button
                                onClick={() => fetchPendingDescriptions(true)}
                                className="text-xs text-green-700 hover:text-green-900 underline font-semibold"
                            >
                                Refrescar ahora
                            </button>
                        </div>

                        {/* Collapsible Tampermonkey Script Section */}
                        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-900 space-y-1.5">
                            <div className="font-bold flex items-center space-x-1.5 text-amber-950">
                                <span>⚠️ ¿Por qué no aparece el botón "🎯 Apuntar Atrás" en SAP todavía?</span>
                            </div>
                            <p className="text-[11px] leading-relaxed">
                                Tampermonkey sigue ejecutando la versión <strong>v7.8</strong> en tu navegador hasta que actualices el código. Para tener los 3 botones morados:
                            </p>
                            <ol className="list-decimal list-inside text-[11px] space-y-1 font-medium text-amber-900 ml-1">
                                <li>Haz clic en el botón <strong>📋 Copiar Script (v7.9)</strong> de abajo.</li>
                                <li>En tu navegador, abre <strong>Tampermonkey</strong> &gt; edita el script &gt; selecciona todo (<kbd className="bg-amber-100 px-1 py-0.5 rounded border border-amber-300">Ctrl+A</kbd>) &gt; pega (<kbd className="bg-amber-100 px-1 py-0.5 rounded border border-amber-300">Ctrl+V</kbd>) y guarda (<kbd className="bg-amber-100 px-1 py-0.5 rounded border border-amber-300">Ctrl+S</kbd>).</li>
                                <li>Regresa a la pestaña de SAP WebGUI y <strong>recarga la página (F5)</strong>. Verás la barra con la insignia azul <strong>v7.9</strong> y el botón morado <strong>🎯 Apuntar Atrás</strong>.</li>
                            </ol>
                        </div>

                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                            <button
                                onClick={() => setShowScriptDetails(!showScriptDetails)}
                                className="w-full text-left px-3 py-2.5 bg-gray-50 hover:bg-gray-100 flex items-center justify-between text-xs font-semibold text-gray-700"
                            >
                                <span>📜 Script de Tampermonkey para SAP WebGUI IQS3 (v7.9 - 3 Botones Morados + Retorno F3)</span>
                                <span>{showScriptDetails ? '▲ Ocultar' : '▼ Mostrar / Copiar'}</span>
                            </button>

                            {showScriptDetails && (
                                <div className="p-3 bg-white space-y-2 border-t border-gray-200">
                                    <div className="flex justify-between items-center">
                                        <span className="text-[11px] font-semibold text-gray-700">Versión 7.9 con guardián de retorno y botón Atrás:</span>
                                        <button
                                            onClick={handleCopyScript}
                                            className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-bold shadow-xs transition-colors"
                                        >
                                            {scriptCopied ? '✓ ¡Script v7.9 Copiado!' : '📋 Copiar Script (v7.9)'}
                                        </button>
                                    </div>
                                    <pre className="text-[10px] font-mono bg-gray-900 text-green-400 p-2.5 rounded-md overflow-x-auto max-h-48 border border-gray-700">
                                        {tampermonkeyScript}
                                    </pre>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Tab 3: Paste mode */}
                {activeTab === 'paste' && (
                    <div className="space-y-3 py-2">
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 space-y-1">
                            <p className="font-semibold">💡 Pegado directo desde SAP WebGUI, IQS3 o Excel:</p>
                            <p>
                                Copie directamente las filas de la tabla en SAP (por ejemplo las columnas con el <strong>Número de ECN</strong> y el <strong>Texto Breve / Descripción</strong>) y péguelas aquí.
                            </p>
                        </div>

                        <div>
                            <div className="flex justify-between items-center mb-1">
                                <label className="text-xs font-semibold text-gray-700">
                                    Contenido copiado de SAP WebGUI:
                                </label>
                                {previewParsedCount > 0 && (
                                    <span className="text-xs text-green-700 font-medium">
                                        ✓ Se detectaron {previewParsedCount} fila(s) para actualizar
                                    </span>
                                )}
                            </div>
                            <textarea
                                value={pasteContent}
                                onChange={e => setPasteContent(e.target.value)}
                                rows={6}
                                placeholder="Ejemplo:&#10;2026-1010&#9;Assy Cable Harness Replacement for 5205&#10;2026-1011&#9;Update BOM with alternative ceramic resistor&#10;10054231&#9;Change valve gasket specification"
                                className="w-full text-xs font-mono p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none bg-white text-gray-900"
                            />
                        </div>

                        {pasteFeedback && (
                            <div className={`p-3 rounded-lg text-xs font-medium ${
                                pasteFeedback.type === 'success'
                                    ? 'bg-green-50 text-green-800 border border-green-200'
                                    : 'bg-red-50 text-red-800 border border-red-200'
                            }`}>
                                {pasteFeedback.message}
                            </div>
                        )}

                        <div className="flex justify-end space-x-2 pt-2 border-t border-gray-200">
                            <Button
                                variant="secondary"
                                onClick={() => setPasteContent('')}
                                disabled={isSavingPaste || !pasteContent}
                            >
                                Limpiar
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleSavePasteData}
                                disabled={isSavingPaste || !pasteContent.trim()}
                                className="bg-blue-600 hover:bg-blue-700 text-white"
                            >
                                {isSavingPaste ? 'Guardando...' : `Guardar ${previewParsedCount > 0 ? previewParsedCount : ''} Descripciones en BD`}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Tab 4: Single ECN or manual assign */}
                {activeTab === 'single' && (
                    <div className="space-y-4 py-2">
                        <p className="text-xs text-gray-600">
                            Consulte o asigne directamente la descripción de un ECN específico o una máscara de búsqueda:
                        </p>

                        <div className="space-y-3">
                            <div>
                                <label className="block text-xs font-semibold text-gray-700 mb-1">
                                    Número de ECN o Máscara:
                                </label>
                                <input
                                    type="text"
                                    value={ecnInput}
                                    onChange={e => setEcnInput(e.target.value)}
                                    placeholder="ej. 2026-*, 2025-*, o 10023456"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-gray-700 mb-1">
                                    Descripción oficial (Opcional - si desea asignarla manualmente):
                                </label>
                                <input
                                    type="text"
                                    value={manualDescription}
                                    onChange={e => setManualDescription(e.target.value)}
                                    placeholder="Descripción extraída de SAP IQS3 / CC03"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
                                />
                            </div>
                        </div>

                        {singleFeedback && (
                            <div className={`p-3 rounded-lg text-xs font-medium ${
                                singleFeedback.type === 'success'
                                    ? 'bg-green-50 text-green-800 border border-green-200'
                                    : 'bg-red-50 text-red-800 border border-red-200'
                            }`}>
                                {singleFeedback.message}
                            </div>
                        )}

                        <div className="flex justify-end space-x-2 pt-2 border-t border-gray-200">
                            <Button
                                variant="secondary"
                                onClick={onClose}
                                disabled={isProcessingSingle}
                            >
                                Cerrar
                            </Button>
                            <Button
                                variant="primary"
                                onClick={handleExecuteSingleOrPattern}
                                disabled={isProcessingSingle || !ecnInput.trim()}
                                className="bg-blue-600 hover:bg-blue-700 text-white"
                            >
                                {isProcessingSingle ? 'Procesando...' : (manualDescription ? '💾 Guardar Descripción' : '🔍 Consultar Coincidencias')}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
};

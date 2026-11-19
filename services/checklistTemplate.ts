export const CHECKLIST_TEMPLATE = [
    // --- Material & Planning ---
    { department: "AME: Product engineering", question: "¿Están todos los datos de los nuevos materiales disponibles en PDM (Team Center)?" },
    { department: "AME: Product engineering", question: "¿Los materiales modificados por este ECN afectan a otros productos que no están listados en este ECN?" },
    { department: "Material Planning", question: "¿Se está inactivando el componente obsoleto y necesitamos iniciar una eliminación progresiva para ese componente?" },
    { department: "Material Planning", question: "¿Se requiere una extensión para nuevos materiales en SAP?" },
    { department: "Material Planning", question: "¿Es alcanzable la fecha de inicio de SAP?" },
    { department: "Material Planning", question: "¿La fecha de entrega del primer producto modificado según el ECN está identificada y comunicada?" },
    { department: "Material Planning", question: "¿Hay suficiente stock de los materiales obsoletos para cubrir hasta la implementación (Sitio+Proveedor+Tránsito)?" },
    { department: "Material Planning", question: "¿Es necesario ejecutar el MRP para los materiales afectados después de la implementación?" },
    { department: "Material Planning", question: "¿Se han actualizado las listas de materiales (BOMs) para la planificación (MRP)?" },
    { department: "Material Planning", question: "¿Están informados los planificadores de materiales sobre los cambios?" },
    
    // --- Sourcing & Panning ---
    { department: "Strategic / Tactical buyer", question: "¿El comprador táctico ha sido notificado sobre la compra de los nuevos componentes?" },
    { department: "Strategic / Tactical buyer", question: "¿Está disponible el proveedor?" },
    { department: "Strategic / Tactical buyer", question: "¿Está la cotización del proveedor disponible?" },
    { department: "Strategic / Tactical buyer", question: "¿Están los precios disponibles en SAP?" },
    { department: "Strategic / Tactical buyer", question: "¿El comprador estratégico ha sido notificado sobre la eliminación progresiva del componente obsoleto?" },

    // --- Manufacturing Process ---
    { department: "AME: Process engineering", question: "¿El proceso de manufactura se ve afectado por este cambio?" },
    { department: "AME: Process engineering", question: "¿Se necesitan cambios en el diseño de herramientas o accesorios?" },
    { department: "AME: Process engineering", question: "¿Se ha solicitado y aprobado la cotización de los cambios?" },
    { department: "AME: Process engineering", question: "¿Está el proveedor listo para construir las nuevas herramientas/accesorios?" },
    { department: "AME: Process engineering", question: "¿Están disponibles las nuevas herramientas/accesorios para la prueba?" },
    { department: "AME: Process engineering", question: "¿Se necesitan cambios en el programa de la máquina?" },
    { department: "AME: Process engineering", question: "¿Están los nuevos programas disponibles para la prueba?" },
    { department: "AME: Process engineering", question: "¿Se necesitan cambios en el programa de prueba?" },
    { department: "AME: Process engineering", question: "¿Están los nuevos programas de prueba disponibles para la prueba?" },
    { department: "AME: Process engineering", question: "¿Están las instrucciones de trabajo, ayudas visuales y otra documentación actualizadas?" },
    { department: "AME: Process engineering", question: "¿Se requiere un nuevo empaque?" },
    { department: "AME: Process engineering", question: "¿Está el nuevo empaque disponible para la prueba?" },
    { department: "AME: Process engineering", question: "¿Hay algún impacto en el tiempo de ciclo?" },
    { department: "AME: Process engineering", question: "¿Se han realizado los estudios de tiempo?" },
    { department: "AME: Process engineering", question: "¿Se requiere capacitación para los operadores?" },
    { department: "AME: Process engineering", question: "¿Se ha completado la capacitación?" },

    // --- Quality ---
    { department: "AME: Quality engineering", question: "¿Se requiere la aprobación de la primera pieza (FAI)?" },
    { department: "AME: Quality engineering", question: "¿Se ha solicitado al proveedor la aprobación de la primera pieza (FAI)?" },
    { department: "AME: Quality engineering", question: "¿Se ha aprobado la FAI del proveedor?" },
    { department: "AME: Quality engineering", question: "¿Se ha aprobado la FAI interna?" },
    { department: "AME: Quality engineering", question: "¿Es necesario actualizar el plan de control?" },
    { department: "AME: Quality engineering", question: "¿Está el plan de control actualizado?" },
    { department: "AME: Quality engineering", question: "¿Es necesario actualizar el PFMEA?" },
    { department: "AME: Quality engineering", question: "¿Está el PFMEA actualizado?" },
    { department: "AME: Quality engineering", question: "¿Se necesitan cambios en los medidores?" },
    { department: "AME: Quality engineering", question: "¿Están los nuevos medidores disponibles?" },
    { department: "AME: Quality engineering", question: "¿Es necesario actualizar los planes de inspección de SAP?" },
    { department: "AME: Quality engineering", question: "¿Están los planes de inspección de SAP actualizados?" },
    { department: "AME: Quality engineering", question: "¿Está el departamento de calidad informado sobre los cambios?" },

    // --- Warehouse ---
    { department: "Warehouse", question: "¿El ECN está afectando algún trabajo en proceso (WIP)?" },
    { department: "Warehouse", question: "¿El ECN está afectando algún producto terminado?" },
    { department: "Warehouse", question: "¿Es necesario bloquear el inventario?" },
    { department: "Warehouse", question: "¿Es necesario volver a etiquetar el inventario?" },
    { department: "Warehouse", question: "¿Es necesario un retrabajo?" },
    { department: "Warehouse", question: "¿Están los nuevos materiales disponibles en el almacén?" },
    { department: "Warehouse", question: "¿Se requiere alguna acción para los materiales obsoletos en el almacén?" },

    // --- Finance ---
    { department: "Finance", question: "¿Se necesita una nueva estructura de costos?" },
    { department: "Finance", question: "¿Están los costos actualizados en SAP?" },
    { department: "Finance", question: "¿Hay algún impacto en el costo?" },
    { department: "Finance", question: "¿Se requiere alguna acción para la chatarra (scrap)?" },
    
    // --- HSE ---
    { department: "HSE", question: "¿Se requiere alguna actualización de la evaluación de riesgos?" },
];
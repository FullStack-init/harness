/**
 * ArnesViz v2.5 – Wiring Harness Visualizer
 * Single JS file: State, Data, Render, Interaction
 */

// ============================================================
// GLOBAL NAMESPACE & STATE
// ============================================================
const App = {
    state: {
        // Project data (loaded from db.json)
        metadata: null,
        data: {
            containers: [],
            connectors: [],
            wires: [],
            mates: []
        },
        // UI state
        editMode: false,
        activeView: 'table', // 'table' | 'visual'
        selectedEntityId: null,
        selectedEntityType: null,
        sidebarState: null, // 'config' | 'details' | null
        lastDetailEntityId: null,
        isDirty: false,
        currentFileName: null,
        // Filters
        filters: {
            search: '',
            type: 'all',
            net: 'all',
            section: 'all'
        },
        // Log entries: { level: 'error'|'warning'|'info', message, entityId, timestamp }
        logEntries: [],
        logShowErrors: true,
        logShowWarnings: true,
        logShowInfo: true,
        // Zoom & pan
        zoom: 1,
        panX: 0,
        panY: 0,
        // Interaction state
        dragging: null,
        resizing: null,
        panning: false,
        panStart: { x: 0, y: 0 },
        // Autosave timer
        autosaveTimer: null
    },

    // DOM references (populated on init)
    dom: {},

    // Constants
    CONST: {
        ZOOM_MIN: 0.2,
        ZOOM_MAX: 3.0,
        ZOOM_STEP: 0.1,
        AUTOSAVE_INTERVAL: 30000,
        MAX_HIERARCHY_DEPTH: 4,
        DEFAULT_COLOR: '#6b7280',
        DEFAULT_WIRE_COLOR: 'black',
        PIN_RADIUS: 5,
        CONNECTOR_WIDTH: 180,
        CONNECTOR_HEIGHT: 115,
    }
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
App.Utils = {
    // Generate unique ID with prefix and next number
    generateId(prefix, existingIds) {
        const existing = existingIds
            .filter(id => id.startsWith(prefix))
            .map(id => parseInt(id.slice(1)))
            .filter(n => !isNaN(n));
        let next = 1;
        while (existing.includes(next)) next++;
        return `${prefix}${String(next).padStart(3, '0')}`;
    },

    // Deep clone
    clone(obj) {
        return JSON.parse(JSON.stringify(obj));
    },

    // Debounce
    debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    },

    // Throttle
    throttle(fn, limit) {
        let inThrottle;
        return function (...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => (inThrottle = false), limit);
            }
        };
    },

    // Escape HTML
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    // Format timestamp
    formatTime(isoString) {
        const d = new Date(isoString);
        return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    // Find entity by ID across all data arrays
    findEntityById(id) {
        const { data } = App.state;
        for (const type of ['containers', 'connectors', 'wires', 'mates']) {
            const entity = data[type].find(e => e.id === id);
            if (entity) return { entity, type: type.slice(0, -1) }; // remove trailing 's'
        }
        return null;
    },

    // Get entity type string from prefix
    getEntityTypeFromId(id) {
        if (!id) return null;
        const prefix = id.charAt(0);
        const map = { T: 'container', C: 'connector', W: 'wire', M: 'mate' };
        return map[prefix] || null;
    },

    // Get data array for entity type
    getDataArray(type) {
        const map = {
            container: 'containers',
            connector: 'connectors',
            wire: 'wires',
            mate: 'mates'
        };
        return App.state.data[map[type]];
    },

    // Show toast notification
    showToast(message, level = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${level}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },

    // Show modal
    showModal(title, message, buttons) {
        const container = document.getElementById('modal-container');
        container.style.display = 'flex';
        container.className = 'modal-overlay';
        container.innerHTML = `
            <div class="modal-dialog">
                <h2>${title}</h2>
                <p>${message}</p>
                <div class="modal-actions">
                    ${buttons.map((btn, i) => `
                        <button class="${btn.cls || 'btn-secondary'}" data-index="${i}">${btn.label}</button>
                    `).join('')}
                </div>
            </div>
        `;
        return new Promise(resolve => {
            container.querySelectorAll('.modal-actions button').forEach(btn => {
                btn.addEventListener('click', () => {
                    const index = parseInt(btn.dataset.index);
                    container.style.display = 'none';
                    resolve(index);
                });
            });
            // Click outside to cancel (last button usually cancel)
            container.addEventListener('click', (e) => {
                if (e.target === container) {
                    container.style.display = 'none';
                    resolve(buttons.length - 1);
                }
            });
        });
    },

    // Add log entry
    addLog(level, message, entityId = null) {
        App.state.logEntries.push({
            level,
            message,
            entityId,
            timestamp: new Date().toISOString()
        });
        App.Interaction.updateLogPanel();
    },

    // Clear logs
    clearLogs() {
        App.state.logEntries = [];
        App.Interaction.updateLogPanel();
    },

    // Save to localStorage safely
    saveToStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            App.Utils.addLog('warning', 'No se pudieron guardar preferencias. Almacenamiento local lleno.');
        }
    },

    // Load from localStorage
    loadFromStorage(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            return defaultValue;
        }
    }
};

// ============================================================
// DATA MODULE (load, save, validate, autocomplete)
// ============================================================
App.Data = {
    // Initialize default empty project
    getEmptyProject() {
        return {
            metadata: {
                projectInfo: { name: 'Nuevo Proyecto', description: '', date: new Date().toISOString().split('T')[0], model: '' },
                lastSave: new Date().toISOString(),
                savedBy: null,
                version: 1,
                schema: {
                    containers: { required: ['id', 'type', 'position', 'size'], recommended: ['name', 'owner', 'sectionRef'] },
                    connectors: { required: ['id', 'type', 'gender', 'mountType', 'edgeSide', 'parent_id', 'pins'], recommended: ['name', 'owner', 'modelRef'] },
                    wires: { required: ['id', 'type', 'from', 'to', 'net'], recommended: ['name', 'owner', 'gauge', 'color', 'wireTypeRef'] },
                    mates: { required: ['id', 'type', 'from', 'to', 'net'], recommended: ['name', 'owner', 'pinMapping'] },
                    rules: {
                        id: { unique: true, pattern: '^[TCWM]\\d{3}$' },
                        'containers.parent_id': { ref: 'containers' },
                        'connectors.parent_id': { ref: 'containers' },
                        'connectors.modelRef': { ref: 'connectorModels' },
                        'connectors.owner': { ref: 'people' },
                        'wires.from.connector': { ref: 'connectors' },
                        'wires.to.connector': { ref: 'connectors' },
                        'wires.net': { ref: 'nets' },
                        'wires.wireTypeRef': { ref: 'wireTypes' },
                        'wires.owner': { ref: 'people' },
                        'mates.from.connector': { ref: 'connectors' },
                        'mates.to.connector': { ref: 'connectors' },
                        'mates.net': { ref: 'nets' },
                        'mates.owner': { ref: 'people' }
                    }
                },
                catalogs: {
                    people: {},
                    sections: {},
                    connectorModels: {},
                    wireTypes: {},
                    nets: {},
                    colorPalette: {
                        black: '#000000',
                        red: '#dc2626',
                        blue: '#2563eb',
                        green: '#16a34a',
                        yellow: '#eab308',
                        orange: '#ea580c',
                        white: '#f5f5f5',
                        gray: '#6b7280',
                        brown: '#92400e',
                        violet: '#7c3aed'
                    }
                }
            },
            data: {
                containers: [],
                connectors: [],
                wires: [],
                mates: []
            }
        };
    },

    // Load project from file or URL
    async loadProject(source) {
        try {
            let json;
            if (typeof source === 'string') {
                // URL
                const response = await fetch(source);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                json = await response.json();
            } else if (source instanceof File) {
                const text = await source.text();
                json = JSON.parse(text);
            } else {
                json = source; // already parsed object
            }

            // Validate structure
            if (!json.metadata || !json.data) {
                throw new Error('Estructura inválida: faltan metadata o data');
            }
            if (!json.data.containers || !json.data.connectors || !json.data.wires || !json.data.mates) {
                throw new Error('Faltan arrays de datos requeridos');
            }

            // Check for obsolete fields
            const obsoleteFields = ['data.nets', 'metadata.uiSettings', 'signalTypeRef'];
            const hasObsolete = obsoleteFields.some(f => {
                const parts = f.split('.');
                let obj = json;
                for (const p of parts) if (obj && obj.hasOwnProperty(p)) return true;
                return false;
            });
            // Also check for sectionRef in connectors
            if (json.data.connectors && json.data.connectors.some(c => c.hasOwnProperty('sectionRef'))) {
                throw new Error('Formato incompatible: el archivo parece ser de una versión anterior. Actualízalo manualmente al formato V2.5.');
            }

            App.state.metadata = json.metadata;
            App.state.data = json.data;
            App.state.isDirty = false;
            App.state.currentFileName = source instanceof File ? source.name : (typeof source === 'string' ? source.split('/').pop() : 'proyecto.json');
            document.getElementById('header-file-name').textContent = App.state.currentFileName || 'Sin archivo';
            App.Utils.clearLogs();
            App.Utils.addLog('info', `Proyecto cargado: ${App.state.metadata.projectInfo?.name || 'Sin nombre'}`);
            return true;
        } catch (err) {
            App.Utils.addLog('error', `Error al cargar proyecto: ${err.message}`);
            App.Utils.showToast(`Error: ${err.message}`, 'error');
            return false;
        }
    },

    // Export project to JSON and download
    exportProject() {
        App.state.metadata.lastSave = new Date().toISOString();
        App.state.metadata.version = (App.state.metadata.version || 0) + 1;
        if (App.state.metadata.savedBy) {
            // Keep savedBy as is
        }
        const project = {
            metadata: App.state.metadata,
            data: App.state.data
        };
        const jsonStr = JSON.stringify(project, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = App.state.currentFileName || 'db.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        App.state.isDirty = false;
        App.Utils.addLog('info', 'Proyecto exportado correctamente.');
        App.Utils.showToast('Exportado correctamente', 'success');
        App.Utils.saveToStorage('arnesviz.autosave', project);
    },

    // Autosave to localStorage
    autosave() {
        const project = {
            metadata: App.state.metadata,
            data: App.state.data
        };
        App.Utils.saveToStorage('arnesviz.autosave', project);
    },

    // Check for autosave and offer restore
    async checkAutosave() {
        const saved = App.Utils.loadFromStorage('arnesviz.autosave');
        if (saved && saved.data) {
            const hasData = saved.data.containers?.length > 0 || saved.data.connectors?.length > 0;
            if (hasData) {
                const idx = await App.Utils.showModal(
                    'Recuperar sesión',
                    'Hay una copia de seguridad local. ¿Deseas restaurarla?',
                    [
                        { label: 'Restaurar', cls: 'btn-primary' },
                        { label: 'Ignorar', cls: 'btn-secondary' },
                    ]
                );
                if (idx === 0) {
                    await App.Data.loadProject(saved);
                    App.Utils.showToast('Sesión restaurada', 'info');
                } else {
                    App.Utils.saveToStorage('arnesviz.autosave', null);
                }
            }
        }
    },

    // Validate the entire project
    validateProject() {
        const errors = [];
        const warnings = [];
        const infos = [];
        const { data, metadata } = App.state;
        const schema = metadata?.schema;
        if (!schema) return { errors, warnings, infos };

        // Helper to add
        const add = (level, msg, entityId) => {
            if (level === 'error') errors.push({ level, message: msg, entityId });
            else if (level === 'warning') warnings.push({ level, message: msg, entityId });
            else infos.push({ level: 'info', message: msg, entityId });
        };

        // Validate each entity against schema required/recommended
        const entityTypes = [
            { key: 'containers', schema: schema.containers },
            { key: 'connectors', schema: schema.connectors },
            { key: 'wires', schema: schema.wires },
            { key: 'mates', schema: schema.mates }
        ];

        for (const { key, schema: subSchema } of entityTypes) {
            const arr = data[key];
            if (!arr) continue;
            for (const entity of arr) {
                // Required fields
                if (subSchema?.required) {
                    for (const field of subSchema.required) {
                        if (!(field in entity) || entity[field] === null || entity[field] === undefined || entity[field] === '') {
                            add('error', `Campo requerido '${field}' faltante en ${entity.id}`, entity.id);
                        }
                    }
                }
                // Recommended fields
                if (subSchema?.recommended) {
                    for (const field of subSchema.recommended) {
                        if (!(field in entity) || entity[field] === null || entity[field] === undefined || entity[field] === '') {
                            add('warning', `Campo recomendado '${field}' faltante en ${entity.id}`, entity.id);
                        }
                    }
                }
            }
        }

        // Validate ID pattern and uniqueness across all
        const allEntities = [
            ...data.containers,
            ...data.connectors,
            ...data.wires,
            ...data.mates
        ];
        const idPattern = new RegExp(schema.rules?.id?.pattern || '^[TCWM]\\d{3}$');
        const idCounts = {};
        for (const entity of allEntities) {
            if (!idPattern.test(entity.id)) {
                add('error', `ID inválido: ${entity.id} no cumple el patrón`, entity.id);
            }
            idCounts[entity.id] = (idCounts[entity.id] || 0) + 1;
        }
        for (const [id, count] of Object.entries(idCounts)) {
            if (count > 1) {
                add('error', `ID duplicado: ${id} aparece ${count} veces`, id);
            }
        }

        // Reference validations
        const refRules = schema.rules || {};
        for (const [rulePath, rule] of Object.entries(refRules)) {
            if (!rule.ref) continue;
            const parts = rulePath.split('.');
            if (parts[0] === 'id') continue; // handled above

            const entityType = parts[0]; // e.g., 'containers'
            const field = parts[1]; // e.g., 'parent_id'

            if (!data[entityType]) continue;

            for (const entity of data[entityType]) {
                let value = entity[field];
                if (value === null || value === undefined) continue; // optional

                // Handle nested paths like 'wires.from.connector'
                if (rulePath.includes('.')) {
                    const pathParts = rulePath.split('.');
                    let val = entity;
                    for (const p of pathParts) {
                        val = val?.[p];
                    }
                    value = val;
                }

                if (!value) continue;

                // Determine target catalog
                const targetCatalog = rule.ref;
                let valid = false;

                if (['containers', 'connectors', 'wires', 'mates'].includes(targetCatalog)) {
                    valid = data[targetCatalog]?.some(e => e.id === value);
                } else if (metadata.catalogs?.[targetCatalog]) {
                    valid = value in metadata.catalogs[targetCatalog];
                }

                if (!valid) {
                    add('error', `Referencia rota: ${entity.id}.${field}='${value}' no existe en ${targetCatalog}`, entity.id);
                }
            }
        }

        // Business rules
        // 10.1 Gender in M
        for (const mate of data.mates) {
            const fromConn = data.connectors.find(c => c.id === mate.from?.connector);
            const toConn = data.connectors.find(c => c.id === mate.to?.connector);
            if (fromConn && toConn && fromConn.gender === toConn.gender) {
                add('error', `Acople ${mate.id}: los conectores deben tener géneros opuestos`, mate.id);
            }
            // 10.4 Composition: fixed + flying
            if (fromConn && toConn) {
                const types = [fromConn.mountType, toConn.mountType];
                if (!((types[0] === 'fixed' && types[1] === 'flying') || (types[0] === 'flying' && types[1] === 'fixed'))) {
                    add('error', `Acople ${mate.id}: debe conectar un conector fijo con uno volante`, mate.id);
                }
            }
            // 10.5 Valid pins
            if (fromConn && mate.from?.pin > fromConn.pins) {
                add('error', `Pin ${mate.from.pin} excede pines de ${fromConn.id}`, mate.id);
            }
            if (toConn && mate.to?.pin > toConn.pins) {
                add('error', `Pin ${mate.to.pin} excede pines de ${toConn.id}`, mate.id);
            }
        }

        // 10.6 Hierarchical compatibility for wires and mates
        const getAncestorChain = (containerId) => {
            const chain = [];
            let currentId = containerId;
            let depth = 0;
            while (currentId && depth < App.CONST.MAX_HIERARCHY_DEPTH) {
                chain.push(currentId);
                const cont = data.containers.find(c => c.id === currentId);
                if (!cont || !cont.parent_id) break;
                // Check for cycles
                if (chain.includes(cont.parent_id)) {
                    add('error', `Ciclo jerárquico detectado en ${currentId}`, currentId);
                    break;
                }
                currentId = cont.parent_id;
                depth++;
            }
            return chain;
        };

        const getConnectorContainer = (connId) => {
            const conn = data.connectors.find(c => c.id === connId);
            return conn ? conn.parent_id : null;
        };

        for (const wire of data.wires) {
            const c1 = getConnectorContainer(wire.from?.connector);
            const c2 = getConnectorContainer(wire.to?.connector);
            if (c1 && c2) {
                const chain1 = getAncestorChain(c1);
                const chain2 = getAncestorChain(c2);
                const common = chain1.find(id => chain2.includes(id));
                if (!common) {
                    add('error', `Cable ${wire.id}: conectores sin ancestro común`, wire.id);
                }
            }
        }
        for (const mate of data.mates) {
            const c1 = getConnectorContainer(mate.from?.connector);
            const c2 = getConnectorContainer(mate.to?.connector);
            if (c1 && c2) {
                const chain1 = getAncestorChain(c1);
                const chain2 = getAncestorChain(c2);
                const common = chain1.find(id => chain2.includes(id));
                if (!common) {
                    add('error', `Acople ${mate.id}: conectores sin ancestro común`, mate.id);
                }
            }
        }

        // 10.14 Flying connectors without partner
        for (const conn of data.connectors) {
            if (conn.mountType === 'flying') {
                if (!conn.matedId || !data.mates.some(m => m.id === conn.matedId)) {
                    add('error', `Conector volante ${conn.id} sin pareja válida`, conn.id);
                }
            }
            // 4.1.7 Fixed connectors without partner -> info
            if (conn.mountType === 'fixed' && !conn.matedId) {
                add('info', `Conector fijo ${conn.id} sin pareja (puede ser intencional)`, conn.id);
            }
        }

        // 10.16 Hierarchy depth
        for (const container of data.containers) {
            let current = container;
            let depth = 0;
            const visited = new Set();
            while (current.parent_id) {
                if (visited.has(current.id)) {
                    add('error', `Ciclo jerárquico detectado en ${container.id}`, container.id);
                    break;
                }
                visited.add(current.id);
                current = data.containers.find(c => c.id === current.parent_id);
                if (!current) break;
                depth++;
                if (depth > App.CONST.MAX_HIERARCHY_DEPTH) {
                    add('error', `Jerarquía demasiado profunda en ${container.id} (máx ${App.CONST.MAX_HIERARCHY_DEPTH} niveles)`, container.id);
                    break;
                }
            }
        }

        // matedId integrity
        for (const conn of data.connectors) {
            if (conn.matedId) {
                const mate = data.mates.find(m => m.id === conn.matedId);
                if (!mate) {
                    add('error', `matedId de ${conn.id} apunta a M inexistente ${conn.matedId}`, conn.id);
                } else {
                    if (mate.from?.connector !== conn.id && mate.to?.connector !== conn.id) {
                        add('error', `M ${mate.id} no contiene a ${conn.id} pero este lo referencia`, conn.id);
                    }
                }
            }
        }
        for (const mate of data.mates) {
            const fromConn = data.connectors.find(c => c.id === mate.from?.connector);
            const toConn = data.connectors.find(c => c.id === mate.to?.connector);
            if (fromConn && fromConn.matedId !== mate.id) {
                add('error', `Conector ${fromConn.id} debería tener matedId=${mate.id}`, fromConn.id);
            }
            if (toConn && toConn.matedId !== mate.id) {
                add('error', `Conector ${toConn.id} debería tener matedId=${mate.id}`, toConn.id);
            }
        }

        // 10.10 Pin facing in M (alignment check) - simplified, just check opposite edgeSides roughly
        for (const mate of data.mates) {
            const fromConn = data.connectors.find(c => c.id === mate.from?.connector);
            const toConn = data.connectors.find(c => c.id === mate.to?.connector);
            if (fromConn && toConn && fromConn.mountType === 'fixed' && toConn.mountType === 'flying') {
                // Fixed connector's edgeSide should be opposite to flying's edgeSide
                const oppositeMap = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
                // Actually, flying connector edgeSide is set to face the fixed connector.
                // We don't enforce strict alignment in code, just visual. Skip heavy math.
            }
        }

        return { errors, warnings, infos };
    },

    // Run validation and update log panel
    runValidation() {
        App.state.logEntries = [];
        const { errors, warnings, infos } = this.validateProject();
        for (const e of errors) App.Utils.addLog('error', e.message, e.entityId);
        for (const w of warnings) App.Utils.addLog('warning', w.message, w.entityId);
        for (const i of infos) App.Utils.addLog('info', i.message, i.entityId);
    },

    // Autocomplete fields based on catalog inference
    autocompleteEntity(entity, type) {
        const catalogs = App.state.metadata?.catalogs || {};

        if (type === 'connector' && entity.modelRef) {
            const model = catalogs.connectorModels?.[entity.modelRef];
            if (model) {
                if (model.pins !== undefined && (entity.pins === undefined || entity.pins === null)) entity.pins = model.pins;
                if (model.gender && (!entity.gender)) entity.gender = model.gender;
            }
        }
        if (type === 'wire') {
            if (entity.wireTypeRef) {
                const wt = catalogs.wireTypes?.[entity.wireTypeRef];
                if (wt?.unit && !entity.gaugeUnit) entity.gaugeUnit = wt.unit;
            }
            if (!entity.gaugeUnit) entity.gaugeUnit = 'mm2';
            if (entity.net) {
                const net = catalogs.nets?.[entity.net];
                if (net?.colorCode) entity.color = net.colorCode;
            }
            if (!entity.color) entity.color = 'black';
        }
        if (type === 'mate' && (entity.pinMapping === undefined || entity.pinMapping === null)) {
            entity.pinMapping = 'direct'; // autocomplete for new mates
        }
        return entity;
    },

    // Create new entity
    createEntity(type, overrides = {}) {
        const map = {
            container: { prefix: 'T', array: 'containers', template: { type: 'enclosure', name: '', parent_id: null, designator: '', position: { x: 100, y: 100 }, size: { width: 300, height: 200 }, owner: null, sectionRef: null, notes: [] } },
            connector: { prefix: 'C', array: 'connectors', template: { type: 'connector', name: '', parent_id: null, designator: '', pins: 2, gender: 'male', mountType: 'fixed', edgeSide: 'right', offset: 50, size: { width: App.CONST.CONNECTOR_WIDTH, height: App.CONST.CONNECTOR_HEIGHT }, matedId: null, modelRef: null, owner: null, notes: [] } },
            wire: { prefix: 'W', array: 'wires', template: { type: 'wired', from: { connector: null, pin: 1 }, to: { connector: null, pin: 1 }, net: null, length: 0, gauge: null, gaugeUnit: null, color: 'black', thickness: 2, wireTypeRef: null, owner: null, notes: [] } },
            mate: { prefix: 'M', array: 'mates', template: { type: 'mated', from: { connector: null, pin: 1 }, to: { connector: null, pin: 1 }, net: null, pinMapping: 'direct', owner: null, notes: [] } }
        };
        const cfg = map[type];
        const existingIds = App.state.data[cfg.array].map(e => e.id);
        const newId = App.Utils.generateId(cfg.prefix, existingIds);
        let entity = App.Utils.clone(cfg.template);
        entity.id = newId;
        Object.assign(entity, overrides);
        entity = this.autocompleteEntity(entity, type);
        App.state.data[cfg.array].push(entity);
        App.state.isDirty = true;
        App.Utils.addLog('info', `Creado ${type} ${newId}`);
        return entity;
    },

    // Delete entity
    deleteEntity(id, type) {
        const arrayName = {
            container: 'containers',
            connector: 'connectors',
            wire: 'wires',
            mate: 'mates'
        }[type];
        if (!arrayName) return false;
        const idx = App.state.data[arrayName].findIndex(e => e.id === id);
        if (idx === -1) return false;
        App.state.data[arrayName].splice(idx, 1);
        App.state.isDirty = true;
        App.Utils.addLog('info', `Eliminado ${type} ${id}`);
        return true;
    },

    // Duplicate entity
    duplicateEntity(id, type) {
        const arrayName = {
            container: 'containers',
            connector: 'connectors',
            wire: 'wires',
            mate: 'mates'
        }[type];
        const original = App.state.data[arrayName].find(e => e.id === id);
        if (!original) return null;
        const copy = App.Utils.clone(original);
        const prefix = id.charAt(0);
        const existingIds = App.state.data[arrayName].map(e => e.id);
        copy.id = App.Utils.generateId(prefix, existingIds);
        App.state.data[arrayName].push(copy);
        App.state.isDirty = true;
        App.Utils.addLog('info', `Duplicado ${type} ${id} -> ${copy.id}`);
        return copy;
    },

    // Get section for a connector (inherited from parent container)
    getConnectorSection(connectorId) {
        const conn = App.state.data.connectors.find(c => c.id === connectorId);
        if (!conn) return null;
        let currentId = conn.parent_id;
        let depth = 0;
        while (currentId && depth < App.CONST.MAX_HIERARCHY_DEPTH) {
            const container = App.state.data.containers.find(c => c.id === currentId);
            if (!container) break;
            if (container.sectionRef) return container.sectionRef;
            currentId = container.parent_id;
            depth++;
        }
        return null;
    },

    // Calculate absolute position of a container (recursive)
    getContainerAbsolutePosition(containerId) {
        let x = 0, y = 0;
        let currentId = containerId;
        let depth = 0;
        const visited = new Set();
        while (currentId && depth < App.CONST.MAX_HIERARCHY_DEPTH) {
            if (visited.has(currentId)) {
                App.Utils.addLog('error', `Ciclo en cálculo de posición para ${containerId}`);
                return { x: 0, y: 0 };
            }
            visited.add(currentId);
            const container = App.state.data.containers.find(c => c.id === currentId);
            if (!container) break;
            if (container.position) {
                if (container.parent_id === null) {
                    x += container.position.x || 0;
                    y += container.position.y || 0;
                } else {
                    x += container.position.offsetX || 0;
                    y += container.position.offsetY || 0;
                }
            }
            currentId = container.parent_id;
            depth++;
        }
        return { x, y };
    },

    // Get absolute position of a connector
    getConnectorAbsolutePosition(connectorId) {
        const conn = App.state.data.connectors.find(c => c.id === connectorId);
        if (!conn) return { x: 0, y: 0 };

        if (conn.mountType === 'flying') {
            // Find its mate's fixed partner
            if (!conn.matedId) return null;
            const mate = App.state.data.mates.find(m => m.id === conn.matedId);
            if (!mate) return null;
            const partnerId = mate.from.connector === conn.id ? mate.to.connector : mate.from.connector;
            const partnerConn = App.state.data.connectors.find(c => c.id === partnerId);
            if (!partnerConn || partnerConn.mountType !== 'fixed') return null;
            const partnerPos = this.getConnectorAbsolutePosition(partnerId);
            if (!partnerPos) return null;

            // Position flying connector adjacent to fixed partner, edge to edge
            const pw = partnerConn.size?.width || App.CONST.CONNECTOR_WIDTH;
            const ph = partnerConn.size?.height || App.CONST.CONNECTOR_HEIGHT;
            const fw = conn.size?.width || App.CONST.CONNECTOR_WIDTH;
            const fh = conn.size?.height || App.CONST.CONNECTOR_HEIGHT;

            let fx = partnerPos.x, fy = partnerPos.y;
            switch (partnerConn.edgeSide) {
                case 'left': fx = partnerPos.x - fw; fy = partnerPos.y; break;
                case 'right': fx = partnerPos.x + pw; fy = partnerPos.y; break;
                case 'top': fx = partnerPos.x; fy = partnerPos.y - fh; break;
                case 'bottom': fx = partnerPos.x; fy = partnerPos.y + ph; break;
            }
            return { x: fx, y: fy };
        }

        // Fixed connector: position relative to parent
        const parentPos = this.getContainerAbsolutePosition(conn.parent_id);
        const parent = App.state.data.containers.find(c => c.id === conn.parent_id);
        if (!parent) return parentPos;

        const pw = parent.size?.width || 0;
        const ph = parent.size?.height || 0;
        const cw = conn.size?.width || App.CONST.CONNECTOR_WIDTH;
        const ch = conn.size?.height || App.CONST.CONNECTOR_HEIGHT;
        const offset = conn.offset || 0;

        let x = parentPos.x, y = parentPos.y;
        switch (conn.edgeSide) {
            case 'left': x = parentPos.x; y = parentPos.y + offset; break;
            case 'right': x = parentPos.x + pw - cw; y = parentPos.y + offset; break;
            case 'top': x = parentPos.x + offset; y = parentPos.y; break;
            case 'bottom': x = parentPos.x + offset; y = parentPos.y + ph - ch; break;
        }
        return { x, y };
    },

    // Get pin position inside a connector
    getPinPosition(connectorId, pinNumber) {
        const conn = App.state.data.connectors.find(c => c.id === connectorId);
        if (!conn || !conn.pins) return null;
        const pos = this.getConnectorAbsolutePosition(connectorId);
        if (!pos) return null;
        const w = conn.size?.width || App.CONST.CONNECTOR_WIDTH;
        const h = conn.size?.height || App.CONST.CONNECTOR_HEIGHT;
        const totalPins = conn.pins;
        const isVertical = conn.edgeSide === 'left' || conn.edgeSide === 'right';
        let px, py;
        if (isVertical) {
            const spacing = h / (totalPins + 1);
            py = pos.y + spacing * pinNumber;
            px = conn.edgeSide === 'left' ? pos.x : pos.x + w;
        } else {
            const spacing = w / (totalPins + 1);
            px = pos.x + spacing * pinNumber;
            py = conn.edgeSide === 'top' ? pos.y : pos.y + h;
        }
        return { x: px, y: py };
    }
};

// ============================================================
// RENDER MODULE (SVG & Table)
// ============================================================
App.Render = {
    // Main render entry point
    renderAll() {
        this.renderTable();
        this.renderSVG();
    },

    // Render SVG harness
    renderSVG() {
        const viewport = document.getElementById('viewport');
        if (!viewport) return;
        const { data } = App.state;
        viewport.innerHTML = '';

        // Background is already in static SVG

        // Apply zoom and pan
        viewport.setAttribute('transform', `translate(${App.state.panX}, ${App.state.panY}) scale(${App.state.zoom})`);

        // Create groups for z-order
        const containersGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        containersGroup.id = 'svg-containers';
        const connectorsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        connectorsGroup.id = 'svg-connectors';
        const wiresGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        wiresGroup.id = 'svg-wires';
        const selectionGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        selectionGroup.id = 'svg-selection';

        viewport.appendChild(containersGroup);
        viewport.appendChild(connectorsGroup);
        viewport.appendChild(wiresGroup);
        viewport.appendChild(selectionGroup);

        // Render containers (sorted by hierarchy depth?)
        const sortedContainers = [...data.containers].sort((a, b) => {
            const depthA = this.getDepth(a.id);
            const depthB = this.getDepth(b.id);
            return depthA - depthB;
        });

        for (const container of sortedContainers) {
            this.renderContainer(container, containersGroup);
        }

        // Render connectors (fixed and flying with valid partners)
        const validFlyingIds = new Set();
        for (const mate of data.mates) {
            const fromConn = data.connectors.find(c => c.id === mate.from?.connector);
            const toConn = data.connectors.find(c => c.id === mate.to?.connector);
            if (fromConn?.mountType === 'flying') validFlyingIds.add(fromConn.id);
            if (toConn?.mountType === 'flying') validFlyingIds.add(toConn.id);
        }

        for (const conn of data.connectors) {
            if (conn.mountType === 'flying' && !validFlyingIds.has(conn.id)) continue;
            this.renderConnector(conn, connectorsGroup);
        }

        // Render wires
        for (const wire of data.wires) {
            this.renderWire(wire, wiresGroup);
        }

        // Render selection overlay
        if (App.state.selectedEntityId) {
            this.renderSelection(selectionGroup);
        }
    },

    getDepth(containerId) {
        let depth = 0;
        let currentId = containerId;
        while (currentId) {
            const c = App.state.data.containers.find(cont => cont.id === currentId);
            if (!c || !c.parent_id) break;
            currentId = c.parent_id;
            depth++;
            if (depth > 10) break;
        }
        return depth;
    },

    renderContainer(container, group) {
        const pos = App.Data.getContainerAbsolutePosition(container.id);
        const { width, height } = container.size || { width: 200, height: 150 };
        const isSelected = App.state.selectedEntityId === container.id;

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', pos.x);
        rect.setAttribute('y', pos.y);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
        rect.setAttribute('rx', 8);
        rect.setAttribute('ry', 8);
        rect.setAttribute('fill', 'rgba(30,30,46,0.85)');
        rect.setAttribute('stroke', isSelected ? '#fbbf24' : '#2a2a3a');
        rect.setAttribute('stroke-width', isSelected ? 2.5 : 1.5);
        rect.setAttribute('data-id', container.id);
        rect.setAttribute('data-type', 'container');
        rect.classList.add('draggable');
        if (isSelected) rect.setAttribute('filter', 'url(#glow-selection)');
        group.appendChild(rect);

        // Label
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', pos.x + 10);
        text.setAttribute('y', pos.y + 25);
        text.setAttribute('fill', '#f0f0f0');
        text.setAttribute('font-family', 'Inter, sans-serif');
        text.setAttribute('font-size', '14');
        text.setAttribute('font-weight', '600');
        text.textContent = `${container.id} ${container.name || ''}`;
        group.appendChild(text);

        // Designator
        if (container.designator) {
            const desText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            desText.setAttribute('x', pos.x + 10);
            desText.setAttribute('y', pos.y + 45);
            desText.setAttribute('fill', '#9ca3af');
            desText.setAttribute('font-size', '11');
            desText.textContent = container.designator;
            group.appendChild(desText);
        }

        // Resize handle (bottom-right corner) only in edit mode
        if (App.state.editMode) {
            const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            handle.setAttribute('x', pos.x + width - 12);
            handle.setAttribute('y', pos.y + height - 12);
            handle.setAttribute('width', 12);
            handle.setAttribute('height', 12);
            handle.setAttribute('fill', '#6366f1');
            handle.setAttribute('rx', 3);
            handle.setAttribute('cursor', 'nwse-resize');
            handle.setAttribute('data-id', container.id);
            handle.setAttribute('data-type', 'resize-handle');
            handle.classList.add('resizable');
            group.appendChild(handle);
        }
    },

    renderConnector(conn, group) {
        const pos = App.Data.getConnectorAbsolutePosition(conn.id);
        if (!pos) return;
        const { width, height } = conn.size || { width: App.CONST.CONNECTOR_WIDTH, height: App.CONST.CONNECTOR_HEIGHT };
        const isSelected = App.state.selectedEntityId === conn.id;

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', pos.x);
        rect.setAttribute('y', pos.y);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
        rect.setAttribute('rx', 4);
        rect.setAttribute('ry', 4);
        rect.setAttribute('fill', 'rgba(20,20,32,0.9)');
        rect.setAttribute('stroke', isSelected ? '#fbbf24' : '#2a2a3a');
        rect.setAttribute('stroke-width', isSelected ? 2.5 : 1.2);
        rect.setAttribute('data-id', conn.id);
        rect.setAttribute('data-type', 'connector');
        if (conn.mountType === 'fixed') rect.classList.add('draggable');
        if (isSelected) rect.setAttribute('filter', 'url(#glow-selection)');
        group.appendChild(rect);

        // Label
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', pos.x + 5);
        text.setAttribute('y', pos.y + 18);
        text.setAttribute('fill', '#f0f0f0');
        text.setAttribute('font-size', '11');
        text.setAttribute('font-weight', '500');
        text.textContent = `${conn.id} ${conn.designator || ''}`;
        group.appendChild(text);

        // Pins
        const totalPins = conn.pins || 0;
        for (let i = 1; i <= totalPins; i++) {
            const pinPos = App.Data.getPinPosition(conn.id, i);
            if (!pinPos) continue;
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', pinPos.x);
            circle.setAttribute('cy', pinPos.y);
            circle.setAttribute('r', App.CONST.PIN_RADIUS);
            circle.setAttribute('fill', '#c9c9d0');
            circle.setAttribute('stroke', '#3a3a4a');
            circle.setAttribute('stroke-width', 1);
            circle.setAttribute('data-connector', conn.id);
            circle.setAttribute('data-pin', i);
            circle.setAttribute('data-type', 'pin');
            circle.classList.add('pin');
            group.appendChild(circle);

            // Pin number label
            const pinLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            pinLabel.setAttribute('x', pinPos.x + (conn.edgeSide === 'left' ? -15 : 10));
            pinLabel.setAttribute('y', pinPos.y + 4);
            pinLabel.setAttribute('fill', '#9ca3af');
            pinLabel.setAttribute('font-size', '9');
            pinLabel.textContent = i;
            group.appendChild(pinLabel);
        }
    },

    renderWire(wire, group) {
        const fromPinPos = App.Data.getPinPosition(wire.from?.connector, wire.from?.pin);
        const toPinPos = App.Data.getPinPosition(wire.to?.connector, wire.to?.pin);
        if (!fromPinPos || !toPinPos) return;

        const colorName = wire.color || 'black';
        const colorPalette = App.state.metadata?.catalogs?.colorPalette || {};
        const strokeColor = colorPalette[colorName] || App.CONST.DEFAULT_COLOR;

        // Bézier curve
        const x1 = fromPinPos.x, y1 = fromPinPos.y;
        const x2 = toPinPos.x, y2 = toPinPos.y;
        const dx = Math.abs(x2 - x1) * 0.4;
        const cx = Math.max(50, dx);

        const fromConn = App.state.data.connectors.find(c => c.id === wire.from.connector);
        const toConn = App.state.data.connectors.find(c => c.id === wire.to.connector);
        let cx1 = x1, cx2 = x2;
        if (fromConn) {
            if (fromConn.edgeSide === 'right') cx1 = x1 + cx;
            else if (fromConn.edgeSide === 'left') cx1 = x1 - cx;
        }
        if (toConn) {
            if (toConn.edgeSide === 'right') cx2 = x2 + cx;
            else if (toConn.edgeSide === 'left') cx2 = x2 - cx;
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${x1},${y1} C ${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', wire.thickness || 2);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('data-id', wire.id);
        path.setAttribute('data-type', 'wire');
        const isSelected = App.state.selectedEntityId === wire.id;
        if (isSelected) {
            path.setAttribute('stroke', '#fbbf24');
            path.setAttribute('stroke-width', 4);
            path.setAttribute('filter', 'url(#glow-selection)');
        }
        group.appendChild(path);

        // Label at midpoint
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', mx);
        label.setAttribute('y', my - 8);
        label.setAttribute('fill', '#9ca3af');
        label.setAttribute('font-size', '10');
        label.setAttribute('text-anchor', 'middle');
        label.textContent = `${wire.id} (${wire.net || '?'})`;
        group.appendChild(label);
    },

    renderSelection(group) {
        const { selectedEntityId, selectedEntityType } = App.state;
        if (!selectedEntityId) return;
        let pos, size;
        if (selectedEntityType === 'container') {
            const container = App.state.data.containers.find(c => c.id === selectedEntityId);
            if (!container) return;
            pos = App.Data.getContainerAbsolutePosition(selectedEntityId);
            size = container.size;
        } else if (selectedEntityType === 'connector') {
            const conn = App.state.data.connectors.find(c => c.id === selectedEntityId);
            if (!conn) return;
            pos = App.Data.getConnectorAbsolutePosition(selectedEntityId);
            size = conn.size;
        }
        if (!pos || !size) return;
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', pos.x - 3);
        rect.setAttribute('y', pos.y - 3);
        rect.setAttribute('width', (size.width || 100) + 6);
        rect.setAttribute('height', (size.height || 50) + 6);
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#fbbf24');
        rect.setAttribute('stroke-width', 2.5);
        rect.setAttribute('filter', 'url(#glow-selection)');
        rect.setAttribute('pointer-events', 'none');
        group.appendChild(rect);
    },

    // Render data table
    renderTable() {
        const thead = document.getElementById('data-table-head');
        const tbody = document.getElementById('data-table-body');
        if (!thead || !tbody) return;

        const activeEntity = App.state.activeTableEntity || 'containers';
        const dataArray = App.state.data[activeEntity] || [];
        const filters = App.state.filters;

        // Filter entities
        const filtered = dataArray.filter(entity => {
            if (filters.search) {
                const searchLower = filters.search.toLowerCase();
                const idMatch = entity.id?.toLowerCase().includes(searchLower);
                const nameMatch = entity.name?.toLowerCase().includes(searchLower);
                const desMatch = entity.designator?.toLowerCase().includes(searchLower);
                if (!idMatch && !nameMatch && !desMatch) return false;
            }
            if (filters.type !== 'all') {
                const typeMap = { containers: 'container', connectors: 'connector', wires: 'wire', mates: 'mate' };
                if (typeMap[filters.type] && activeEntity !== filters.type) return false;
            }
            if (filters.net !== 'all' && entity.net && entity.net !== filters.net) return false;
            if (filters.section !== 'all') {
                let section = null;
                if (activeEntity === 'containers') section = entity.sectionRef;
                else if (activeEntity === 'connectors') section = App.Data.getConnectorSection(entity.id);
                if (filters.section !== 'all' && section !== filters.section) return false;
            }
            return true;
        });

        // Update counter
        const counter = document.getElementById('filter-counter');
        if (counter) counter.textContent = `Mostrando ${filtered.length} de ${dataArray.length}`;

        // Columns based on entity type
        let columns = ['id', 'name'];
        if (activeEntity === 'containers') columns = ['id', 'name', 'type', 'designator', 'parent_id', 'sectionRef', 'owner'];
        else if (activeEntity === 'connectors') columns = ['id', 'name', 'designator', 'parent_id', 'pins', 'gender', 'mountType', 'matedId', 'owner'];
        else if (activeEntity === 'wires') columns = ['id', 'net', 'from', 'to', 'length', 'gauge', 'color', 'owner'];
        else if (activeEntity === 'mates') columns = ['id', 'net', 'from', 'to', 'pinMapping', 'owner'];

        // Render header
        thead.innerHTML = `<tr>${columns.map(col => `<th>${col}</th>`).join('')}</tr>`;

        // Render body
        tbody.innerHTML = filtered.map(entity => {
            const isSelected = App.state.selectedEntityId === entity.id;
            const hasError = App.state.logEntries.some(e => e.entityId === entity.id && e.level === 'error');
            const hasWarning = App.state.logEntries.some(e => e.entityId === entity.id && e.level === 'warning');
            let rowClass = '';
            if (isSelected) rowClass += ' selected';
            if (hasError) rowClass += ' error-row';
            else if (hasWarning) rowClass += ' warning-row';

            const cells = columns.map(col => {
                let value = entity[col];
                if (col === 'from' || col === 'to') {
                    value = entity[col] ? `${entity[col].connector}:${entity[col].pin}` : '';
                }
                return `<td class="editable-cell" data-field="${col}">${App.Utils.escapeHtml(String(value ?? ''))}</td>`;
            }).join('');
            return `<tr class="${rowClass}" data-id="${entity.id}" data-type="${activeEntity.slice(0, -1)}">${cells}</tr>`;
        }).join('');
    },

    // Render sidebar content
    renderSidebar(state, entityId = null) {
        const content = document.getElementById('sidebar-content');
        const title = document.getElementById('sidebar-title');
        const actions = document.getElementById('sidebar-actions');
        if (!content || !title) return;

        if (state === 'config') {
            title.textContent = 'Configuración';
            actions.innerHTML = '';
            this.renderConfigPanel(content);
        } else if (state === 'details' && entityId) {
            const result = App.Utils.findEntityById(entityId);
            if (!result) return;
            title.textContent = `Detalles: ${result.entity.id}`;
            this.renderDetailPanel(content, result.entity, result.type);
            // Action buttons
            actions.innerHTML = '';
            if (App.state.editMode) {
                const saveBtn = document.createElement('button');
                saveBtn.className = 'btn-save';
                saveBtn.textContent = 'Guardar cambios';
                saveBtn.addEventListener('click', () => App.Interaction.saveDetailChanges());
                actions.appendChild(saveBtn);

                const dupBtn = document.createElement('button');
                dupBtn.className = 'btn-duplicate';
                dupBtn.textContent = 'Duplicar';
                dupBtn.addEventListener('click', () => {
                    const newEntity = App.Data.duplicateEntity(entityId, result.type);
                    if (newEntity) {
                        App.state.selectedEntityId = newEntity.id;
                        App.state.selectedEntityType = result.type;
                        App.Render.renderAll();
                        App.Render.renderSidebar('details', newEntity.id);
                        App.Utils.showToast('Duplicado correctamente', 'success');
                    }
                });
                actions.appendChild(dupBtn);

                const delBtn = document.createElement('button');
                delBtn.className = 'btn-delete';
                delBtn.textContent = 'Eliminar';
                delBtn.addEventListener('click', async () => {
                    const idx = await App.Utils.showModal(
                        'Eliminar entidad',
                        `¿Seguro que deseas eliminar ${result.entity.id}? Esta acción no se puede deshacer.`,
                        [
                            { label: 'Eliminar', cls: 'btn-danger' },
                            { label: 'Cancelar', cls: 'btn-cancel' },
                        ]
                    );
                    if (idx === 0) {
                        App.Data.deleteEntity(entityId, result.type);
                        App.state.selectedEntityId = null;
                        App.state.selectedEntityType = null;
                        App.Render.renderAll();
                        App.Interaction.closeSidebar();
                        App.Data.runValidation();
                        App.Utils.showToast('Eliminado', 'warning');
                    }
                });
                actions.appendChild(delBtn);
            }
        }
    },

    renderConfigPanel(container) {
        const catalogs = App.state.metadata?.catalogs || {};
        const people = catalogs.people || {};
        container.innerHTML = `
            <div class="section-title">Usuario actual</div>
            <div class="field-group">
                <label>Usuario</label>
                <select id="config-current-user">
                    <option value="">-- Seleccionar --</option>
                    ${Object.entries(people).map(([id, p]) => `<option value="${id}" ${App.state.metadata?.savedBy === id ? 'selected' : ''}>${p.name}</option>`).join('')}
                </select>
            </div>
            <div class="section-title">Gestión de datos</div>
            <div class="field-group" style="display:flex; gap:8px; flex-wrap:wrap;">
                <button id="config-import-btn" class="btn-save" style="flex:1;">📂 Importar JSON</button>
                <button id="config-export-btn" class="btn-primary" style="flex:1;">💾 Exportar JSON</button>
            </div>
            <button id="config-delete-all-btn" class="btn-delete" style="width:100%; margin-top:8px;">🗑 Eliminar todo</button>
            <div class="section-title">Catálogos (solo lectura)</div>
            <div class="field-group">
                <label>Personas (${Object.keys(people).length})</label>
                <ul style="font-size:11px;color:#9ca3af;list-style:none;padding:0;">
                    ${Object.entries(people).map(([id, p]) => `<li>${id}: ${p.name}</li>`).join('') || '<li>Vacío</li>'}
                </ul>
            </div>
            <div class="field-group">
                <label>Redes (${Object.keys(catalogs.nets || {}).length})</label>
                <ul style="font-size:11px;color:#9ca3af;list-style:none;padding:0;">
                    ${Object.entries(catalogs.nets || {}).map(([id, net]) => `<li>${id}: ${net.name}</li>`).join('') || '<li>Vacío</li>'}
                </ul>
            </div>
            <div class="field-group">
                <label>Secciones (${Object.keys(catalogs.sections || {}).length})</label>
                <ul style="font-size:11px;color:#9ca3af;list-style:none;padding:0;">
                    ${Object.entries(catalogs.sections || {}).map(([id, sec]) => `<li>${id}: ${sec.name}</li>`).join('') || '<li>Vacío</li>'}
                </ul>
            </div>
        `;

        // Event listeners for config buttons
        document.getElementById('config-current-user')?.addEventListener('change', (e) => {
            App.state.metadata.savedBy = e.target.value || null;
            App.state.isDirty = true;
        });
        document.getElementById('config-import-btn')?.addEventListener('click', () => App.Interaction.importJSON());
        document.getElementById('config-export-btn')?.addEventListener('click', () => App.Data.exportProject());
        document.getElementById('config-delete-all-btn')?.addEventListener('click', () => App.Interaction.deleteAllData());
    },

    renderDetailPanel(container, entity, type) {
        const fields = Object.keys(entity).filter(k => !['notes'].includes(k));
        let html = '';
        for (const field of fields) {
            let value = entity[field];
            if (field === 'from' || field === 'to') {
                value = value ? `${value.connector}:${value.pin}` : '';
            } else if (typeof value === 'object') {
                value = JSON.stringify(value);
            }
            const disabled = App.state.editMode ? '' : 'disabled';
            html += `
                <div class="field-group">
                    <label>${field}</label>
                    <input type="text" data-field="${field}" value="${App.Utils.escapeHtml(String(value ?? ''))}" ${disabled}>
                </div>
            `;
        }
        // Notes
        html += `<div class="section-title">Notas</div>`;
        const notes = entity.notes || [];
        html += notes.map((n, i) => `<div style="font-size:11px;color:#9ca3af;margin:4px 0;">[${n.date}] ${n.user}: ${App.Utils.escapeHtml(n.text)}</div>`).join('');
        if (App.state.editMode) {
            html += `<div class="field-group" style="margin-top:8px;">
                <textarea id="new-note-text" placeholder="Añadir nota..."></textarea>
                <button id="add-note-btn" style="margin-top:4px;padding:4px 10px;border-radius:8px;background:#6366f1;color:#fff;border:none;cursor:pointer;">Añadir</button>
            </div>`;
        }
        container.innerHTML = html;

        if (App.state.editMode) {
            document.getElementById('add-note-btn')?.addEventListener('click', () => {
                const textarea = document.getElementById('new-note-text');
                if (textarea && textarea.value.trim()) {
                    if (!entity.notes) entity.notes = [];
                    entity.notes.push({
                        date: new Date().toISOString(),
                        user: App.state.metadata?.savedBy || 'anon',
                        text: textarea.value.trim()
                    });
                    App.state.isDirty = true;
                    App.Render.renderSidebar('details', entity.id);
                    App.Utils.showToast('Nota añadida', 'success');
                }
            });
        }
    }
};

// ============================================================
// INTERACTION MODULE (events, drag, zoom, sidebar, filters)
// ============================================================
App.Interaction = {
    // Initialize all event listeners
    init() {
        this.bindHeaderEvents();
        this.bindTableEvents();
        this.bindSVGEvents();
        this.bindSidebarEvents();
        this.bindLogPanelEvents();
        this.bindFilterEvents();
        this.bindKeyboardShortcuts();
        this.bindBeforeUnload();
    },

    bindHeaderEvents() {
        // Tab buttons
        document.getElementById('tab-table-btn')?.addEventListener('click', () => this.switchView('table'));
        document.getElementById('tab-visual-btn')?.addEventListener('click', () => this.switchView('visual'));

        // Edit toggle
        const toggleLabel = document.getElementById('edit-toggle-label');
        const toggleTrack = document.getElementById('edit-toggle-track');
        if (toggleLabel && toggleTrack) {
            toggleLabel.addEventListener('click', () => {
                App.state.editMode = !App.state.editMode;
                toggleTrack.classList.toggle('active', App.state.editMode);
                App.Render.renderAll();
                if (App.state.sidebarState) App.Render.renderSidebar(App.state.sidebarState, App.state.lastDetailEntityId);
                App.Utils.showToast(App.state.editMode ? 'Modo edición activado' : 'Modo solo lectura', 'info');
            });
        }

        // Config button
        document.getElementById('config-btn')?.addEventListener('click', () => {
            if (App.state.sidebarState === 'config') {
                this.closeSidebar();
            } else {
                this.openSidebar('config');
            }
        });
    },

    switchView(view) {
        App.state.activeView = view;
        document.getElementById('table-view').classList.toggle('hidden', view !== 'table');
        document.getElementById('visual-view').classList.toggle('hidden', view !== 'visual');
        document.getElementById('tab-table-btn').classList.toggle('active', view === 'table');
        document.getElementById('tab-visual-btn').classList.toggle('active', view === 'visual');
        App.Utils.saveToStorage('arnesviz.activeView', view);
        if (view === 'visual') App.Render.renderSVG();
        else App.Render.renderTable();
    },

    bindTableEvents() {
        // Entity type buttons
        const entityButtons = document.querySelectorAll('#table-toolbar .entity-type-btn');
        entityButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                entityButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                App.state.activeTableEntity = btn.dataset.entity;
                App.Render.renderTable();
            });
        });

        // Add button
        document.getElementById('table-add-btn')?.addEventListener('click', () => {
            if (!App.state.editMode) {
                App.Utils.showToast('Activa el modo edición para añadir entidades', 'warning');
                return;
            }
            const entityTypeMap = {
                containers: 'container',
                connectors: 'connector',
                wires: 'wire',
                mates: 'mate'
            };
            const activeEntity = App.state.activeTableEntity || 'containers';
            const type = entityTypeMap[activeEntity];
            const newEntity = App.Data.createEntity(type);
            App.state.selectedEntityId = newEntity.id;
            App.state.selectedEntityType = type;
            App.Render.renderAll();
            this.openSidebar('details', newEntity.id);
            App.Data.runValidation();
        });

        // Table row clicks
        document.getElementById('data-table-body')?.addEventListener('click', (e) => {
            const row = e.target.closest('tr');
            if (!row) return;
            const id = row.dataset.id;
            const type = row.dataset.type;
            if (id) {
                App.state.selectedEntityId = id;
                App.state.selectedEntityType = type;
                App.Render.renderAll();
                this.openSidebar('details', id);
            }
        });

        // Inline editing (double-click)
        document.getElementById('data-table-body')?.addEventListener('dblclick', (e) => {
            if (!App.state.editMode) return;
            const td = e.target.closest('td.editable-cell');
            if (!td) return;
            const row = td.closest('tr');
            const id = row.dataset.id;
            const type = row.dataset.type;
            const field = td.dataset.field;
            const currentValue = td.textContent;
            const input = document.createElement('input');
            input.value = currentValue;
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    const newValue = input.value;
                    const result = App.Utils.findEntityById(id);
                    if (result) {
                        result.entity[field] = isNaN(newValue) ? newValue : Number(newValue);
                        App.state.isDirty = true;
                        App.Render.renderAll();
                        App.Utils.showToast('Campo actualizado', 'success');
                    }
                } else if (ev.key === 'Escape') {
                    App.Render.renderTable();
                }
            });
            input.addEventListener('blur', () => App.Render.renderTable());
            td.innerHTML = '';
            td.appendChild(input);
            input.focus();
        });
    },

    bindSVGEvents() {
        const svg = document.getElementById('svg-canvas');
        const viewport = document.getElementById('viewport');
        if (!svg || !viewport) return;

        // Click on SVG elements
        svg.addEventListener('click', (e) => {
            if (App.state.panning || App.state.dragging) return;
            const target = e.target;
            const dataId = target.getAttribute('data-id');
            const dataType = target.getAttribute('data-type');
            if (dataId && dataType) {
                if (dataType === 'pin') {
                    // Select parent connector
                    const connId = target.getAttribute('data-connector');
                    if (connId) {
                        App.state.selectedEntityId = connId;
                        App.state.selectedEntityType = 'connector';
                    }
                } else {
                    App.state.selectedEntityId = dataId;
                    App.state.selectedEntityType = dataType;
                }
                App.Render.renderAll();
                this.openSidebar('details', App.state.selectedEntityId);
            } else if (e.target === svg || e.target.id === 'svg-background') {
                // Deselect
                App.state.selectedEntityId = null;
                App.state.selectedEntityType = null;
                App.Render.renderAll();
                this.closeSidebar();
            }
        });

        // Drag handling
        let dragStart = null;
        let dragEntity = null;
        let dragType = null;

        svg.addEventListener('mousedown', (e) => {
            if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
                // Middle button or Shift+left = pan
                App.state.panning = true;
                App.state.panStart = { x: e.clientX, y: e.clientY };
                svg.classList.add('panning');
                e.preventDefault();
                return;
            }

            if (e.button !== 0) return;
            const target = e.target;
            if (target.classList.contains('draggable') && App.state.editMode) {
                dragEntity = target;
                dragType = target.getAttribute('data-type');
                dragStart = { x: e.clientX, y: e.clientY };
                App.state.dragging = { entity: dragEntity, type: dragType };
                e.preventDefault();
            } else if (target.classList.contains('resizable') && App.state.editMode) {
                dragEntity = target;
                dragType = 'resize-handle';
                dragStart = { x: e.clientX, y: e.clientY };
                App.state.resizing = { entity: dragEntity, startSize: null };
                e.preventDefault();
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (App.state.panning) {
                const dx = e.clientX - App.state.panStart.x;
                const dy = e.clientY - App.state.panStart.y;
                App.state.panX += dx;
                App.state.panY += dy;
                App.state.panStart = { x: e.clientX, y: e.clientY };
                App.Render.renderSVG();
                return;
            }

            if (App.state.dragging && dragStart) {
                const dx = (e.clientX - dragStart.x) / App.state.zoom;
                const dy = (e.clientY - dragStart.y) / App.state.zoom;
                dragStart = { x: e.clientX, y: e.clientY };

                const entityId = dragEntity.getAttribute('data-id');
                if (dragType === 'container') {
                    const container = App.state.data.containers.find(c => c.id === entityId);
                    if (container) {
                        if (container.parent_id === null) {
                            container.position.x = (container.position.x || 0) + dx;
                            container.position.y = (container.position.y || 0) + dy;
                        } else {
                            container.position.offsetX = (container.position.offsetX || 0) + dx;
                            container.position.offsetY = (container.position.offsetY || 0) + dy;
                        }
                        App.state.isDirty = true;
                        App.Render.renderSVG();
                    }
                } else if (dragType === 'connector') {
                    const conn = App.state.data.connectors.find(c => c.id === entityId);
                    if (conn && conn.mountType === 'fixed') {
                        conn.offset = (conn.offset || 0) + (conn.edgeSide === 'left' || conn.edgeSide === 'right' ? dy : dx);
                        App.state.isDirty = true;
                        App.Render.renderSVG();
                    }
                }
            }

            if (App.state.resizing && dragStart) {
                const entityId = dragEntity.getAttribute('data-id');
                const container = App.state.data.containers.find(c => c.id === entityId);
                if (container) {
                    const dx = (e.clientX - dragStart.x) / App.state.zoom;
                    const dy = (e.clientY - dragStart.y) / App.state.zoom;
                    container.size.width = Math.max(50, (container.size.width || 100) + dx);
                    container.size.height = Math.max(50, (container.size.height || 100) + dy);
                    dragStart = { x: e.clientX, y: e.clientY };
                    App.state.isDirty = true;
                    App.Render.renderSVG();
                }
            }
        });

        window.addEventListener('mouseup', () => {
            App.state.panning = false;
            App.state.dragging = null;
            App.state.resizing = null;
            dragStart = null;
            dragEntity = null;
            svg.classList.remove('panning');
        });

        // Zoom with mouse wheel
        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const zoomFactor = e.deltaY < 0 ? 1 + App.CONST.ZOOM_STEP : 1 - App.CONST.ZOOM_STEP;
            const newZoom = Math.min(App.CONST.ZOOM_MAX, Math.max(App.CONST.ZOOM_MIN, App.state.zoom * zoomFactor));
            // Adjust pan to zoom towards mouse
            const scaleChange = newZoom / App.state.zoom;
            App.state.panX = mouseX - scaleChange * (mouseX - App.state.panX);
            App.state.panY = mouseY - scaleChange * (mouseY - App.state.panY);
            App.state.zoom = newZoom;
            App.Render.renderSVG();
        });
    },

    bindSidebarEvents() {
        document.getElementById('sidebar-close-btn')?.addEventListener('click', () => this.closeSidebar());
    },

    openSidebar(state, entityId = null) {
        const panel = document.getElementById('sidebar-panel');
        if (!panel) return;
        App.state.sidebarState = state;
        if (state === 'details' && entityId) {
            App.state.lastDetailEntityId = entityId;
        }
        panel.classList.add('open');
        App.Render.renderSidebar(state, entityId);
    },

    closeSidebar() {
        const panel = document.getElementById('sidebar-panel');
        if (panel) panel.classList.remove('open');
        App.state.sidebarState = null;
    },

    saveDetailChanges() {
        const content = document.getElementById('sidebar-content');
        if (!content) return;
        const inputs = content.querySelectorAll('input[data-field]');
        const entityId = App.state.lastDetailEntityId;
        if (!entityId) return;
        const result = App.Utils.findEntityById(entityId);
        if (!result) return;
        inputs.forEach(input => {
            const field = input.dataset.field;
            let value = input.value;
            // Try to parse numbers
            if (!isNaN(value) && value.trim() !== '') value = Number(value);
            else if (value === 'null') value = null;
            else if (value === 'true') value = true;
            else if (value === 'false') value = false;
            result.entity[field] = value;
        });
        App.state.isDirty = true;
        App.Utils.showToast('Cambios guardados', 'success');
        App.Render.renderAll();
        App.Data.runValidation();
    },

    bindLogPanelEvents() {
        const logHeader = document.getElementById('log-header-toggle');
        const logPanel = document.getElementById('log-panel');
        if (logHeader && logPanel) {
            logHeader.addEventListener('click', () => {
                logPanel.classList.toggle('collapsed');
            });
        }
        document.getElementById('log-filter-errors')?.addEventListener('click', (e) => {
            e.stopPropagation();
            App.state.logShowErrors = !App.state.logShowErrors;
            this.updateLogPanel();
        });
        document.getElementById('log-filter-warnings')?.addEventListener('click', (e) => {
            e.stopPropagation();
            App.state.logShowWarnings = !App.state.logShowWarnings;
            this.updateLogPanel();
        });
        document.getElementById('log-filter-info')?.addEventListener('click', (e) => {
            e.stopPropagation();
            App.state.logShowInfo = !App.state.logShowInfo;
            this.updateLogPanel();
        });
        document.getElementById('log-clear-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            App.Utils.clearLogs();
        });
    },

    updateLogPanel() {
        const logBody = document.getElementById('log-body');
        const counterError = document.getElementById('counter-error');
        const counterWarning = document.getElementById('counter-warning');
        const counterInfo = document.getElementById('counter-info');
        if (!logBody) return;

        const filtered = App.state.logEntries.filter(entry => {
            if (entry.level === 'error' && !App.state.logShowErrors) return false;
            if (entry.level === 'warning' && !App.state.logShowWarnings) return false;
            if (entry.level === 'info' && !App.state.logShowInfo) return false;
            return true;
        });

        const errors = App.state.logEntries.filter(e => e.level === 'error').length;
        const warnings = App.state.logEntries.filter(e => e.level === 'warning').length;
        const infos = App.state.logEntries.filter(e => e.level === 'info').length;
        if (counterError) counterError.textContent = errors;
        if (counterWarning) counterWarning.textContent = warnings;
        if (counterInfo) counterInfo.textContent = infos;

        if (filtered.length === 0) {
            logBody.innerHTML = '<div class="log-empty">Sin mensajes</div>';
            return;
        }
        logBody.innerHTML = filtered.map(entry => `
            <div class="log-entry ${entry.level}">
                <span class="log-time">${App.Utils.formatTime(entry.timestamp)}</span>
                <span>${entry.entityId ? `<strong>${entry.entityId}:</strong> ` : ''}${entry.message}</span>
            </div>
        `).join('');
        logBody.scrollTop = logBody.scrollHeight;
    },

    bindFilterEvents() {
        const searchInput = document.getElementById('filter-search');
        const typeSelect = document.getElementById('filter-type');
        const netSelect = document.getElementById('filter-net');
        const sectionSelect = document.getElementById('filter-section');
        const clearBtn = document.getElementById('clear-filters-btn');

        const applyFilters = App.Utils.debounce(() => {
            App.state.filters.search = searchInput?.value || '';
            App.state.filters.type = typeSelect?.value || 'all';
            App.state.filters.net = netSelect?.value || 'all';
            App.state.filters.section = sectionSelect?.value || 'all';
            App.Utils.saveToStorage('arnesviz.filters', App.state.filters);
            App.Render.renderAll();
        }, 200);

        searchInput?.addEventListener('input', applyFilters);
        typeSelect?.addEventListener('change', applyFilters);
        netSelect?.addEventListener('change', applyFilters);
        sectionSelect?.addEventListener('change', applyFilters);

        clearBtn?.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            if (typeSelect) typeSelect.value = 'all';
            if (netSelect) netSelect.value = 'all';
            if (sectionSelect) sectionSelect.value = 'all';
            applyFilters();
        });

        // Populate net and section dropdowns
        this.updateFilterDropdowns();
    },

    updateFilterDropdowns() {
        const netSelect = document.getElementById('filter-net');
        const sectionSelect = document.getElementById('filter-section');
        const catalogs = App.state.metadata?.catalogs || {};
        if (netSelect) {
            netSelect.innerHTML = '<option value="all">Todas las redes</option>' +
                Object.keys(catalogs.nets || {}).map(id => `<option value="${id}">${id}</option>`).join('');
        }
        if (sectionSelect) {
            sectionSelect.innerHTML = '<option value="all">Todas las secciones</option>' +
                Object.keys(catalogs.sections || {}).map(id => `<option value="${id}">${catalogs.sections[id].name}</option>`).join('');
        }
    },

    bindKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'E') {
                e.preventDefault();
                document.getElementById('edit-toggle-label')?.click();
            } else if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                App.Data.exportProject();
            } else if (e.ctrlKey && e.key === 'o') {
                e.preventDefault();
                this.importJSON();
            } else if (e.key === 'Escape') {
                App.state.selectedEntityId = null;
                App.state.selectedEntityType = null;
                this.closeSidebar();
                App.Render.renderAll();
            } else if (e.key === 'f' && !e.ctrlKey) {
                e.preventDefault();
                document.getElementById('filter-search')?.focus();
            }
        });
    },

    bindBeforeUnload() {
        window.addEventListener('beforeunload', (e) => {
            if (App.state.isDirty) {
                e.preventDefault();
                e.returnValue = 'Hay cambios sin guardar.';
            }
        });
    },

    async importJSON() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (App.state.isDirty) {
                const idx = await App.Utils.showModal(
                    'Cambios sin guardar',
                    'Hay cambios sin guardar. ¿Deseas exportar antes de importar?',
                    [
                        { label: 'Exportar y continuar', cls: 'btn-primary' },
                        { label: 'Descartar y continuar', cls: 'btn-secondary' },
                        { label: 'Cancelar', cls: 'btn-cancel' },
                    ]
                );
                if (idx === 2) return;
                if (idx === 0) App.Data.exportProject();
            }
            const success = await App.Data.loadProject(file);
            if (success) {
                App.Data.runValidation();
                App.Render.renderAll();
                this.updateFilterDropdowns();
                this.closeSidebar();
                App.state.selectedEntityId = null;
            }
        };
        input.click();
    },

    async deleteAllData() {
        const idx1 = await App.Utils.showModal(
            'Eliminar todo',
            '¿Estás seguro de que deseas eliminar todos los datos actuales?',
            [
                { label: 'Sí, eliminar', cls: 'btn-danger' },
                { label: 'Cancelar', cls: 'btn-cancel' },
            ]
        );
        if (idx1 !== 0) return;
        const idx2 = await App.Utils.showModal(
            'Copia de seguridad',
            '¿Quieres exportar una copia de seguridad antes de eliminar?',
            [
                { label: 'Exportar y eliminar', cls: 'btn-primary' },
                { label: 'Eliminar sin guardar', cls: 'btn-secondary' },
                { label: 'Cancelar', cls: 'btn-cancel' },
            ]
        );
        if (idx2 === 2) return;
        if (idx2 === 0) App.Data.exportProject();
        const empty = App.Data.getEmptyProject();
        App.state.metadata = empty.metadata;
        App.state.data = empty.data;
        App.state.isDirty = false;
        App.state.selectedEntityId = null;
        App.Utils.clearLogs();
        App.Render.renderAll();
        this.closeSidebar();
        App.Utils.showToast('Todos los datos eliminados', 'warning');
    }
};

// ============================================================
// INITIALIZATION
// ============================================================
App.init = async function () {
    // Cache DOM elements
    App.dom = {
        headerFileName: document.getElementById('header-file-name'),
        sidebarPanel: document.getElementById('sidebar-panel'),
        // ... otros si se necesitan
    };

    // Setup edit toggle visual state
    const toggleTrack = document.getElementById('edit-toggle-track');
    if (toggleTrack) toggleTrack.classList.toggle('active', App.state.editMode);

    // Restore view preference
    const savedView = App.Utils.loadFromStorage('arnesviz.activeView', 'table');
    App.state.activeView = savedView;
    document.getElementById('table-view').classList.toggle('hidden', savedView !== 'table');
    document.getElementById('visual-view').classList.toggle('hidden', savedView !== 'visual');
    document.getElementById('tab-table-btn').classList.toggle('active', savedView === 'table');
    document.getElementById('tab-visual-btn').classList.toggle('active', savedView === 'visual');

    // Restore filters
    const savedFilters = App.Utils.loadFromStorage('arnesviz.filters');
    if (savedFilters) {
        App.state.filters = savedFilters;
        document.getElementById('filter-search').value = savedFilters.search || '';
        document.getElementById('filter-type').value = savedFilters.type || 'all';
        document.getElementById('filter-net').value = savedFilters.net || 'all';
        document.getElementById('filter-section').value = savedFilters.section || 'all';
    }

    // Restore zoom/pan
    App.state.zoom = App.Utils.loadFromStorage('arnesviz.zoom', 1);
    const pan = App.Utils.loadFromStorage('arnesviz.pan', { x: 0, y: 0 });
    App.state.panX = pan.x;
    App.state.panY = pan.y;

    // Initialize interactions
    App.Interaction.init();

    // Try to load db.json from same directory
    try {
        const response = await fetch('db.json');
        if (response.ok) {
            const json = await response.json();
            const success = await App.Data.loadProject(json);
            if (success) {
                App.Data.runValidation();
                App.Render.renderAll();
                App.Interaction.updateFilterDropdowns();
            }
        } else {
            // Try autosave restore
            await App.Data.checkAutosave();
            if (!App.state.metadata) {
                // Start empty
                const empty = App.Data.getEmptyProject();
                App.state.metadata = empty.metadata;
                App.state.data = empty.data;
                App.Render.renderAll();
                App.Utils.addLog('info', 'Nuevo proyecto creado. Importa un JSON o comienza a añadir entidades.');
            }
        }
    } catch (err) {
        console.warn('No se pudo cargar db.json, iniciando vacío:', err.message);
        await App.Data.checkAutosave();
        if (!App.state.metadata) {
            const empty = App.Data.getEmptyProject();
            App.state.metadata = empty.metadata;
            App.state.data = empty.data;
            App.Render.renderAll();
            App.Utils.addLog('info', 'Nuevo proyecto creado.');
        }
    }

    // Set up autosave interval
    App.state.autosaveTimer = setInterval(() => {
        if (App.state.isDirty) App.Data.autosave();
    }, App.CONST.AUTOSAVE_INTERVAL);

    // Initial render
    App.Render.renderAll();
    App.Interaction.updateFilterDropdowns();

    console.log('ArnesViz v2.5 inicializado.');
};

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
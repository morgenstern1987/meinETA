'use strict';

const utils = require('@iobroker/adapter-core');
const http  = require('http');

class EtaTouch extends utils.Adapter {

    constructor(options) {
        super({ ...options, name: 'meineta' });
        this.pollTimer   = null;
        this.menuTree    = null;   // raw parsed menu
        this.groupMap    = {};     // { groupId: { name, vars: [{uri, name}] } }
        this.on('ready',   this.onReady.bind(this));
        this.on('unload',  this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
    }

    // ─── lifecycle ────────────────────────────────────────────────────────────

    async onReady() {
        this.setState('info.connection', false, true);

        const ip   = this.config.ip;
        const port = parseInt(this.config.port) || 8080;

        if (!ip) {
            this.log.warn('No IP configured – adapter idle until configured.');
            return;
        }

        this.baseUrl = `http://${ip}:${port}`;
        this.log.info(`ETA Touch adapter started – target: ${this.baseUrl}`);

        try {
            await this.fetchAndParseMenu();
            await this.pollSelectedGroups();
            this.scheduleNextPoll();
        } catch (e) {
            this.log.error(`Startup error: ${e.message}`);
        }
    }

    onUnload(callback) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        callback();
    }

    // ─── message handler (used by admin UI) ───────────────────────────────────

    onMessage(obj) {
        if (!obj || !obj.command) return;

        switch (obj.command) {
            case 'getGroups':
                // Admin requests the list of groups so the user can select them
                this.fetchAndParseMenu()
                    .then(() => {
                        const groups = Object.entries(this.groupMap).map(([id, g]) => ({
                            value: id,
                            label: g.name
                        }));
                        this.sendTo(obj.from, obj.command, { groups }, obj.callback);
                    })
                    .catch(e => {
                        this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
                    });
                break;

            default:
                break;
        }
    }

    // ─── HTTP helper ──────────────────────────────────────────────────────────

    httpGet(path) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}${path}`;
            http.get(url, { timeout: 10000 }, (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    } else {
                        resolve(data);
                    }
                });
            }).on('error', reject)
              .on('timeout', () => reject(new Error(`Timeout for ${url}`)));
        });
    }

    // ─── XML helpers (no external dependency) ─────────────────────────────────

    /**
     * Minimal XML attribute extractor.
     * Returns { attrName: value, ... } for a single XML tag string.
     */
    parseAttributes(tagStr) {
        const attrs = {};
        const re = /(\w+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(tagStr)) !== null) {
            attrs[m[1]] = m[2];
        }
        return attrs;
    }

    /**
     * Parse the ETA menu XML into a flat group map.
     * Groups are the top-level <fub> elements; within each fub we collect
     * all leaf <object> URIs recursively.
     */
    parseMenuXml(xml) {
        const groupMap = {};

        // Find all fub blocks
        const fubRe = /<fub([^>]*)>([\s\S]*?)<\/fub>/g;
        let fubMatch;
        while ((fubMatch = fubRe.exec(xml)) !== null) {
            const fubAttrs = this.parseAttributes(fubMatch[1]);
            const fubUri   = fubAttrs.uri  || '';
            const fubName  = fubAttrs.name || fubUri;

            // derive a stable group id from uri (replace / with _)
            const groupId = fubUri.replace(/\//g, '_').replace(/^_/, '');

            const vars = [];
            this.collectLeafObjects(fubMatch[2], vars);

            groupMap[groupId] = {
                name: fubName,
                fubUri,
                vars
            };
        }

        return groupMap;
    }

    /**
     * Recursively collect leaf <object> elements (those that have no children
     * or whose children have no further objects).
     */
    collectLeafObjects(xmlChunk, result) {
        // Match every <object …/> or <object …> … </object>
        const objRe = /<object([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g;
        let m;
        while ((m = objRe.exec(xmlChunk)) !== null) {
            const attrs    = this.parseAttributes(m[1]);
            const uri      = attrs.uri  || '';
            const name     = attrs.name || uri;
            const inner    = m[3] || '';
            const hasChild = /<object/.test(inner);

            if (!hasChild && uri) {
                result.push({ uri, name });
            } else if (inner) {
                // recurse
                this.collectLeafObjects(inner, result);
            }
        }
    }

    /**
     * Parse a single <value …> response.
     */
    parseVarXml(xml) {
        const m = /<value([^>]*)>([\s\S]*?)<\/value>/.exec(xml);
        if (!m) return null;
        const attrs = this.parseAttributes(m[1]);
        attrs.rawValue = m[2].trim();
        return attrs;
    }

    // ─── menu fetch ───────────────────────────────────────────────────────────

    async fetchAndParseMenu() {
        const xml      = await this.httpGet('/user/menu');
        this.groupMap  = this.parseMenuXml(xml);
        this.setState('info.connection', true, true);
        this.log.debug(`Menu parsed – ${Object.keys(this.groupMap).length} groups found.`);
    }

    // ─── polling ──────────────────────────────────────────────────────────────

    async pollSelectedGroups() {
        const selected = this.config.selectedGroups || [];
        if (!selected.length) {
            this.log.info('No groups selected – nothing to poll.');
            return;
        }

        for (const groupId of selected) {
            const group = this.groupMap[groupId];
            if (!group) {
                this.log.warn(`Group "${groupId}" not found in menu tree – skipped.`);
                continue;
            }
            await this.pollGroup(groupId, group);
        }
    }

    async pollGroup(groupId, group) {
        const safeGroupName = this.sanitizeId(group.name);

        for (const v of group.vars) {
            try {
                const xml   = await this.httpGet(`/user/var${v.uri}`);
                const data  = this.parseVarXml(xml);
                if (!data) continue;

                // Build ioBroker object path:  eta-touch.0.<groupName>.<varName>
                const safeVarName = this.sanitizeId(v.name);
                const objId       = `${safeGroupName}.${safeVarName}`;

                // Determine numeric value
                const scaleFactor = parseFloat(data.scaleFactor) || 1;
                const decPlaces   = parseInt(data.decPlaces)     || 0;
                const rawNum      = parseFloat(data.rawValue);
                const numValue    = isNaN(rawNum) ? null : rawNum / scaleFactor;

                // Create/update object definition
                await this.setObjectNotExistsAsync(objId, {
                    type: 'state',
                    common: {
                        name:  `${group.name} – ${v.name}`,
                        type:  numValue !== null ? 'number' : 'string',
                        role:  'value',
                        unit:  data.unit || '',
                        read:  true,
                        write: false
                    },
                    native: {
                        uri:           v.uri,
                        scaleFactor,
                        decPlaces,
                        advTextOffset: data.advTextOffset || '0'
                    }
                });

                // Write state
                const stateValue = numValue !== null
                    ? parseFloat(numValue.toFixed(decPlaces))
                    : data.strValue || data.rawValue;

                await this.setStateAsync(objId, { val: stateValue, ack: true });

            } catch (e) {
                this.log.warn(`Failed to read ${v.uri}: ${e.message}`);
            }
        }
        this.log.debug(`Polled group "${group.name}" (${group.vars.length} vars).`);
    }

    scheduleNextPoll() {
        const interval = (parseInt(this.config.pollInterval) || 60) * 1000;
        this.pollTimer = setTimeout(async () => {
            try {
                if (!this.groupMap || !Object.keys(this.groupMap).length) {
                    await this.fetchAndParseMenu();
                }
                await this.pollSelectedGroups();
            } catch (e) {
                this.log.error(`Poll error: ${e.message}`);
                this.setState('info.connection', false, true);
            }
            this.scheduleNextPoll();
        }, interval);
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    /**
     * Make a string safe for use as an ioBroker object ID.
     * Replaces everything that is not a-z, A-Z, 0-9, dot, dash, or underscore.
     */
    sanitizeId(str) {
        return str
            .replace(/[äÄ]/g, 'ae')
            .replace(/[öÖ]/g, 'oe')
            .replace(/[üÜ]/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
            .replace(/__+/g, '_')
            .replace(/^_|_$/g, '');
    }
}

// ─── entry point ──────────────────────────────────────────────────────────────

if (require.main !== module) {
    module.exports = (options) => new EtaTouch(options);
} else {
    new EtaTouch();
}

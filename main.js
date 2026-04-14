"use strict";

const utils = require("@iobroker/adapter-core");
const EtaClient = require("./lib/etaClient");
const { extractVariables } = require("./lib/menuParser");
const { buildObjectPath } = require("./lib/nameMapper");

class MeinEta extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: "meineta"
        });

        this.uriMap = {};

        this.on("ready", this.onReady.bind(this));
    }

    async onReady() {

        try {

            if (!this.config.host) {
                this.log.error("Bitte ETA IP konfigurieren");
                return;
            }

            this.client = new EtaClient(this.config.host, this.config.port);

            await this.cleanupInvalidObjects();

            await this.ensureVarSet();

            await this.discoverVariables();

            this.log.info("Discovery abgeschlossen");

            setTimeout(() => {

                this.pollVars();

                this.pollTimer = setInterval(() => {
                    this.pollVars();
                    this.pollErrors();
                }, this.config.pollInterval);

            }, 3000);

        } catch (error) {

            this.log.error(`Startfehler: ${error}`);

        }

    }

    async cleanupInvalidObjects() {

        const objects = await this.getAdapterObjectsAsync();

        for (const id in objects) {

            const obj = objects[id];

            if (obj.type === "state" && !obj.common?.type) {

                this.log.warn(`Entferne ungültiges Objekt ${id}`);

                await this.delObjectAsync(id);

            }

        }

    }

    async ensureVarSet() {

        try {
            await this.client.put(`/user/vars/${this.config.varset}`);
        } catch {
            this.log.debug("VarSet existiert bereits");
        }

    }

    async discoverVariables() {

        this.log.info("Lese ETA Menüstruktur");

        const data = await this.client.get("/user/menu");

        const menu = data.eta.menu[0];

        const variables = extractVariables(menu);

        this.log.info(`Gefundene Variablen: ${variables.length}`);

        for (const v of variables) {

            const id = buildObjectPath(v.path);

            this.uriMap[v.uri] = id;

            await this.createObjectTree(id, v.name, v.uri);

            const uri = v.uri.replace(/^\//, "");

            try {
                await this.client.put(`/user/vars/${this.config.varset}/${uri}`);
            } catch {
                this.log.debug(`Variable konnte nicht registriert werden: ${uri}`);
            }

        }

    }

    async createObjectTree(id, name, uri) {

        const parts = id.split(".");
        let path = "";

        for (let i = 0; i < parts.length; i++) {

            path = path ? `${path}.${parts[i]}` : parts[i];

            const exists = await this.getObjectAsync(path);

            if (exists) continue;

            const last = i === parts.length - 1;

            if (i === 0) {

                await this.setObjectAsync(path, {
                    type: "device",
                    common: { name: parts[i] },
                    native: {}
                });

                continue;
            }

            if (!last) {

                await this.setObjectAsync(path, {
                    type: "channel",
                    common: { name: parts[i] },
                    native: {}
                });

                continue;
            }

            await this.setObjectAsync(path, {
                type: "state",
                common: {
                    name: name || parts[i],
                    type: "number",
                    role: "value",
                    read: true,
                    write: false,
                    def: 0
                },
                native: { uri }
            });

        }

    }

    async pollVars() {

        try {

            const data = await this.client.get(`/user/vars/${this.config.varset}`);

            const vars = data?.eta?.vars?.[0]?.variable;

            if (!vars) {
                this.log.warn("ETA liefert keine Variablen");
                return;
            }

            for (const v of vars) {

                const uri = v.$.uri;

                const id = this.uriMap[`/${uri}`] || this.uriMap[uri];

                if (!id) continue;

                const obj = await this.getObjectAsync(id);

                if (!obj) continue;

                const raw = parseFloat(v._);
                const scale = parseFloat(v.$.scaleFactor || 1);

                const value = raw / scale;

                const unit = v.$.unit || "";

                if (unit && obj.common.unit !== unit) {

                    obj.common.unit = unit;

                    await this.setObjectAsync(id, obj);

                }

                await this.setStateAsync(id, value, true);

            }

        } catch (error) {

            this.log.error(`Polling Fehler: ${error}`);

        }

    }

    async pollErrors() {

        try {

            const data = await this.client.get("/user/errors");

            const id = "errors.raw";

            await this.setObjectNotExistsAsync(id, {
                type: "state",
                common: {
                    name: "ETA Errors",
                    type: "string",
                    role: "json",
                    read: true,
                    write: false
                },
                native: {}
            });

            await this.setStateAsync(id, JSON.stringify(data), true);

        } catch (error) {

            this.log.error(`Fehler beim Lesen der Fehlerliste: ${error}`);

        }

    }

}

if (require.main !== module) {
    module.exports = (options) => new MeinEta(options);
} else {
    new MeinEta();
}

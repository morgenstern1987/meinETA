const axios = require("axios");
const xml2js = require("xml2js");

class EtaClient {

    constructor(host, port) {
        this.base = `http://${host}:${port}`;
    }

    async get(path) {
        const res = await axios.get(`${this.base}${path}`);
        return xml2js.parseStringPromise(res.data);
    }

    async post(path, data) {
        return axios.post(`${this.base}${path}`, data, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
    }

    async put(path) {
        return axios.put(`${this.base}${path}`);
    }

}

module.exports = EtaClient;

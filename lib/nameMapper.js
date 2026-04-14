function normalizeName(name) {

    if (!name) return "unknown";

    return name
        .toLowerCase()
        .replace(/[ä]/g, "ae")
        .replace(/[ö]/g, "oe")
        .replace(/[ü]/g, "ue")
        .replace(/[ß]/g, "ss")
        .replace(/[^\w]+/g, "_")
        .replace(/^_+|_+$/g, "");

}

function buildObjectPath(pathArray) {

    const names = pathArray.map(normalizeName);
    const last = names[names.length - 1];

    if (names.includes("kessel") || names.includes("boiler"))
        return `boiler.${last}`;

    if (names.includes("puffer") || names.includes("buffer"))
        return `buffer.${last}`;

    if (names.includes("heizkreis") || names.includes("hk1"))
        return `heating.hk1.${last}`;

    if (names.includes("hk2"))
        return `heating.hk2.${last}`;

    if (names.includes("aussentemperatur") || names.includes("outdoor"))
        return `outside.temperature`;

    if (names.includes("pellet"))
        return `pellet.${last}`;

    return names.join(".");

}

module.exports = {
    normalizeName,
    buildObjectPath
};

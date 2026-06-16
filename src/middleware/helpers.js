
const { pool, sql } = require('../db');
const Fuse = require("fuse.js");

const formatDate = (dateString) => {
    return new Date(dateString)
        .toISOString()
        .substring(0, 10);
}

const formatTime = (dateString) => {
    return new Date(dateString)
        .toISOString()
        .substring(11, 16);
};

async function findClosestSearch(search) {
    const candidates = [];

    // Services
    const services = await pool.request().query(`SELECT Name FROM lk_services`);

    services.recordset.forEach(row =>
        candidates.push(row.Name)
    );

    // Labs
    const labs = await pool.request().query(`SELECT Name FROM Labs`);

    labs.recordset.forEach(row =>
        candidates.push(row.Name)
    );

    // States & LGAs
    const locations = await pool.request().query(`
        SELECT DISTINCT state, lga
        FROM Labs
    `);

    locations.recordset.forEach(row => {
        if (row.state) candidates.push(row.state);
        if (row.lga) candidates.push(row.lga);
    });

    const fuse = new Fuse(candidates, {
        threshold: 0.4,
        ignoreLocation: true,
        includeScore: true
    });

    const bestMatch = fuse.search(search);

    
    if (bestMatch.length === 0 || bestMatch.score > 4) {
        return null;
    }

    return bestMatch[0];
}

module.exports = { formatTime, formatDate, findClosestSearch }
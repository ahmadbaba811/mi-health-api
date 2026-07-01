const express = require('express');
const router = express.Router();
const { pool, sql } = require('../db');
const { formatTime, findClosestSearch } = require('../middleware/helpers');
const { Int } = require('mssql');

// GET all labs
router.post('/', async (req, res) => {

    const { page, recordSize } = req.body;
    try {
        const request = pool.request();
        request.input('page', page);
        request.input('recordSize', recordSize);

        const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      ORDER BY distance ASC OFFSET (@page - 1) * @recordSize ROWS 
      FETCH NEXT @recordSize ROWS ONLY
    `);

        const labs = result.recordset.map(lab => ({
            ...lab,
            openTime: formatTime(lab.openTime),
            closeTime: formatTime(lab.closeTime),
            id: lab.id.toString(),
            certifications: lab.certifications ? [result.recordset[0].certifications.split(", ").join(" ")] : []
        }));


        // For each lab, fetch associated services
        const labsWithServices = await Promise.all(
            labs.map(async (lab) => {
                const servicesRequest = pool.request();
                servicesRequest.input('labId', sql.VarChar(50), lab.id.toString());

                const servicesResult = await servicesRequest.query(`
          SELECT s.id, ls.serviceId as labServiceId, s.name, ls.price, ls.duration, s.category, s.description, ls.preparation
          FROM lk_Services s
          INNER JOIN lab_services ls ON s.id = ls.serviceId
          WHERE ls.labId = @labId
          ORDER BY s.name ASC
        `);

                return {
                    ...lab,
                    services: servicesResult.recordset
                };
            })
        );

        res.json(labsWithServices);
    } catch (err) {
        console.error('Error fetching labs:', err);
        res.status(500).json({ error: 'Failed to fetch labs' });
    }
});


router.get('/count', async (req, res) => {
    try {
        const request = pool.request();
        let select = `SELECT COUNT(distinct a.id) FROM Labs a INNER JOIN lab_services b ON a.id = b.LabId INNER JOIN lk_services c ON  c.id = b.serviceId WHERE 1=1 `
        let result = await request.query(select);
        const totalRecords = result.recordset.length
        return res.json({ totalRecords })
    } catch (error) {
        console.error('Failed to get lab count', error)
        return res.status(500).json({ error: 'Unable to fetch lab count' })
    }
})

router.post('/search', async (req, res) => {
    const { searchString, userLocation, useLocation, userDistance, page, recordSize, countRecords } = req.body;
    const request = pool.request();

    let whereClauses = [];
    let select = `SELECT distinct a.id, a.name, area, state, lga, address, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image `
    let where = `(
        state LIKE '%' + @searchString + '%'
        OR lga LIKE '%' + @searchString + '%'
        OR c.name LIKE '%' + @searchString + '%'
        OR a.name LIKE '%' + @searchString + '%'
      )`

    // Search text condition
    if (searchString !== "") {
        request.input("searchString", searchString);

        whereClauses.push(where);
    }

    // Location condition
    if (useLocation === true) {

        request.input("lat", userLocation.lat);
        request.input("lng", userLocation.lng);
        select = select + ` ,ROUND(a.location.STDistance(geography::Point(@lat, @lng, 4326) )/1000, 1) AS distance`
        whereClauses.push(` a.location.STDistance(geography::Point(@lat, @lng, 4326) ) <= ${parseInt(userDistance) <= 0 ? 20000 : parseInt(userDistance)} `);
    }

    let query = `${select} 
    FROM Labs a 
    INNER JOIN lab_services b ON a.id = b.LabId 
    INNER JOIN lk_services c ON  c.id = b.serviceId WHERE 1=1 `

    if (whereClauses.length) {
        query += ` AND ${whereClauses.join(" AND ")}`;
    }

    //count records before limiting the search
    let total_count = 0;

    const _tot = await request.query(query)
    total_count = _tot.recordset.length;

    request.input('page', page);
    request.input('recordSize', recordSize);
    query += ` ORDER BY rating DESC OFFSET (@page - 1) * @recordSize ROWS FETCH NEXT @recordSize ROWS ONLY`

    try {
        let result = await request.query(query);

        let searchUsed = searchString;
        let didYouMean = null;
        let isFuzzyMatch = false;

        if (searchString?.trim() !== "" && result.recordset.length === 0) {
            const closestMatch = await findClosestSearch(searchString);

            if (closestMatch) {
                didYouMean = closestMatch?.item;
                searchUsed = closestMatch?.item;
                isFuzzyMatch = true;

                const fuzzyRequest = pool.request();

                if (useLocation) {
                    fuzzyRequest.input("lat", userLocation.lat);
                    fuzzyRequest.input("lng", userLocation.lng);
                }

                fuzzyRequest.input("searchString", didYouMean);

                const fuzzyWhereClauses = [];

                fuzzyWhereClauses.push(where);

                if (useLocation === true) {
                    fuzzyWhereClauses.push(`a.location.STDistance(geography::Point(@lat,@lng,4326)) <= ${parseInt(userDistance) <= 0 ? 20000 : parseInt(userDistance)}`);
                }

                let fuzzyQuery = `${select}
                    FROM Labs a
                    INNER JOIN lab_services b ON a.id = b.LabId 
                    INNER JOIN lk_services c ON  c.id = b.serviceId
                    WHERE 
                    ${fuzzyWhereClauses.length > 0 && ` ${fuzzyWhereClauses.join(" AND ")} `} 
                    `;

                // _count.input("searchString", searchString);
                const _tot2 = await fuzzyRequest.query(fuzzyQuery)
                total_count = _tot2.recordset.length;

                fuzzyRequest.input('page', page);
                fuzzyRequest.input('recordSize', recordSize);
                fuzzyQuery += ` ORDER BY rating DESC OFFSET (@page - 1) * @recordSize ROWS FETCH NEXT @recordSize ROWS ONLY`
                result = await fuzzyRequest.query(fuzzyQuery);

            }
        }

        const labs = result.recordset.map(lab => ({
            ...lab,
            openTime: formatTime(lab.openTime),
            closeTime: formatTime(lab.closeTime),
            id: lab.id.toString(),
            certifications: lab.certifications ? [result.recordset[0].certifications.split(", ").join(" ")] : []
        }));


        // For each lab, fetch associated services
        const labsWithServices = await Promise.all(labs.map(async (lab) => {
            const servicesRequest = pool.request();
            servicesRequest.input('labId', sql.VarChar(50), lab.id.toString());

            const servicesResult = await servicesRequest.query(`
                        SELECT s.id, s.name, ls.price, ls.duration, s.category, s.description, ls.preparation
                        FROM lk_Services s
                        INNER JOIN lab_services ls ON s.id = ls.serviceId
                        WHERE ls.labId = @labId
                        ORDER BY s.name ASC
                        `);

            return {
                ...lab,
                services: servicesResult.recordset
            };
        })
        );

        res.json({ labs: labsWithServices, didYouMean: didYouMean, isFuzzyMatch, isFuzzyMatch, total_count: total_count });
    } catch (err) {
        console.error('Error fetching labs:', err);
        res.status(500).json({ error: 'Failed to fetch labs' });
    }
});

// GET single lab by ID
router.get('/:id', async (req, res) => {
    try {
        const request = pool.request();
        request.input('id', sql.VarChar(50), req.params.id);

        const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE id = @id
    `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Lab not found' });
        }

        const lab = result.recordset[0];
        lab.certifications = lab.certifications ? JSON.parse(lab.certifications) : [];

        // Fetch associated services
        const servicesRequest = pool.request();
        servicesRequest.input('labId', sql.VarChar(50), req.params.id);

        const servicesResult = await servicesRequest.query(`
      SELECT s.id, s.name, s.price, s.duration, s.category, s.description, s.preparation
      FROM Services s
      INNER JOIN LabServices ls ON s.id = ls.serviceId
      WHERE ls.labId = @labId
      ORDER BY s.name ASC
    `);

        lab.services = servicesResult.recordset;

        res.json(lab);
    } catch (err) {
        console.error('Error fetching lab:', err);
        res.status(500).json({ error: 'Failed to fetch lab' });
    }
});

// GET labs by area
router.get('/area/:area', async (req, res) => {
    try {
        const request = pool.request();
        request.input('area', sql.VarChar(100), req.params.area);

        const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE area = @area
      ORDER BY distance ASC
    `);

        const labs = result.recordset.map(lab => ({
            ...lab,
            certifications: lab.certifications ? JSON.parse(lab.certifications) : []
        }));

        res.json(labs);
    } catch (err) {
        console.error('Error fetching labs by area:', err);
        res.status(500).json({ error: 'Failed to fetch labs' });
    }
});

// GET open labs
router.get('/status/open', async (req, res) => {
    try {
        const request = pool.request();
        const result = await request.query(`
      SELECT id, name, area, address, distance, rating, reviewCount, openTime, closeTime, 
             isOpen, certifications, phone, image 
      FROM Labs 
      WHERE isOpen = 1
      ORDER BY distance ASC
    `);

        const labs = result.recordset.map(lab => ({
            ...lab,
            certifications: lab.certifications ? JSON.parse(lab.certifications) : []
        }));

        res.json(labs);
    } catch (err) {
        console.error('Error fetching open labs:', err);
        res.status(500).json({ error: 'Failed to fetch labs' });
    }
});

// POST create new lab
router.post('/', async (req, res) => {
    const { id, name, area, address, distance, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image } = req.body;

    if (!id || !name || !area || !address) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const request = pool.request();
        request.input('id', sql.VarChar(50), id);
        request.input('name', sql.VarChar(255), name);
        request.input('area', sql.VarChar(100), area);
        request.input('address', sql.VarChar(sql.MAX), address);
        request.input('distance', sql.Float, distance || 0);
        request.input('rating', sql.Float, rating || 0);
        request.input('reviewCount', sql.Int, reviewCount || 0);
        request.input('openTime', sql.VarChar(10), openTime || '');
        request.input('closeTime', sql.VarChar(10), closeTime || '');
        request.input('isOpen', sql.Bit, isOpen || 0);
        request.input('certifications', sql.VarChar(sql.MAX), JSON.stringify(certifications || []));
        request.input('phone', sql.VarChar(20), phone || '');
        request.input('image', sql.VarChar(sql.MAX), image || '');

        await request.query(`
      INSERT INTO Labs (id, name, area, address, distance, rating, reviewCount, openTime, 
                        closeTime, isOpen, certifications, phone, image)
      VALUES (@id, @name, @area, @address, @distance, @rating, @reviewCount, @openTime, 
              @closeTime, @isOpen, @certifications, @phone, @image)
    `);

        res.status(201).json({
            id, name, area, address, distance, rating, reviewCount, openTime, closeTime,
            isOpen, certifications, phone, image
        });
    } catch (err) {
        console.error('Error creating lab:', err);
        res.status(500).json({ error: 'Failed to create lab' });
    }
});

// PUT update lab
router.put('/:id', async (req, res) => {
    const { name, area, address, distance, rating, reviewCount, openTime, closeTime, isOpen, certifications, phone, image } = req.body;

    try {
        const request = pool.request();
        request.input('id', sql.VarChar(50), req.params.id);
        request.input('name', sql.VarChar(255), name);
        request.input('area', sql.VarChar(100), area);
        request.input('address', sql.VarChar(sql.MAX), address);
        request.input('distance', sql.Float, distance);
        request.input('rating', sql.Float, rating);
        request.input('reviewCount', sql.Int, reviewCount);
        request.input('openTime', sql.VarChar(10), openTime);
        request.input('closeTime', sql.VarChar(10), closeTime);
        request.input('isOpen', sql.Bit, isOpen);
        request.input('certifications', sql.VarChar(sql.MAX), JSON.stringify(certifications || []));
        request.input('phone', sql.VarChar(20), phone);
        request.input('image', sql.VarChar(sql.MAX), image);

        await request.query(`
      UPDATE Labs 
      SET name = @name, area = @area, address = @address, distance = @distance, 
          rating = @rating, reviewCount = @reviewCount, openTime = @openTime, 
          closeTime = @closeTime, isOpen = @isOpen, certifications = @certifications, 
          phone = @phone, image = @image
      WHERE id = @id
    `);

        res.json({
            id: req.params.id, name, area, address, distance, rating, reviewCount, openTime,
            closeTime, isOpen, certifications, phone, image
        });
    } catch (err) {
        console.error('Error updating lab:', err);
        res.status(500).json({ error: 'Failed to update lab' });
    }
});

// DELETE lab
router.delete('/:id', async (req, res) => {
    try {
        const request = pool.request();
        request.input('id', sql.VarChar(50), req.params.id);

        await request.query('DELETE FROM Labs WHERE id = @id');

        res.json({ message: 'Lab deleted successfully' });
    } catch (err) {
        console.error('Error deleting lab:', err);
        res.status(500).json({ error: 'Failed to delete lab' });
    }
});

module.exports = router;

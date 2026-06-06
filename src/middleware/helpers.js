


const formatTime = (dateString) => {
    return new Date(dateString)
        .toISOString()
        .substring(11, 16);
};

module.exports = { formatTime }
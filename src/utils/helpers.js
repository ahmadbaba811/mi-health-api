


const generatePassword = (length = 12) => {
    try {
        const lowercase = "abcdefghijklmnopqrstuvwxyz"
        const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        const numbers = "0123456789"
        const special = "!@#$%^&*()_+-=[]{}|;:,.<>?"

        // Guarantee at least one of each required type
        const required = [
            lowercase[Math.floor(Math.random() * lowercase.length)],
            uppercase[Math.floor(Math.random() * uppercase.length)],
            numbers[Math.floor(Math.random() * numbers.length)],
            special[Math.floor(Math.random() * special.length)]
        ]

        const all = lowercase + uppercase + numbers + special

        while (required.length < Math.max(8, length)) {
            required.push(all[Math.floor(Math.random() * all.length)])
        }

        // Shuffle the characters
        return required.sort(() => Math.random() - 0.5).join("")
    } catch (error) {
        console.log(error)
    }
}


module.exports = { generatePassword }
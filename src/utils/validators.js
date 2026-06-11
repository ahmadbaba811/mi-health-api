function validateRegisterInput(email, password, confirmPassword) {
  const errors = [];

  if (!email?.trim()) errors.push("Email is required");

  if (!password) errors.push("Password is required");

  if (password !== confirmPassword)
    errors.push("Passwords do not match");

  if (password && password.length < 6)
    errors.push("Password must be at least 6 characters");

  return errors;
}



module.exports = { validateRegisterInput };
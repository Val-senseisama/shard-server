import bcrypt from "bcrypt";
import { logError } from "./Helpers.js";

export const hashPassword = async (password: string): Promise<string> => {
  try {
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    return hashedPassword;
  } catch (error) {
    logError("hashPassword", error);
    throw new Error("Failed to hash password");
  }
};

export const comparePassword = async (password: string, hashedPassword: string): Promise<boolean> => {
  try {
    return await bcrypt.compare(password, hashedPassword);
  } catch (error) {
    logError("comparePassword", error);
    return false;
  }
};

export const validatePassword = (password: string): boolean => {
  // Password validation rules
  if (!password || password.length < 8) {
    return false;
  }
  
  // Check for at least one uppercase letter, one lowercase letter, and one number
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  
  return hasUpperCase && hasLowerCase && hasNumbers;
}; 
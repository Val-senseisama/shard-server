import jwt from "jsonwebtoken";
import "dotenv/config";
import { catchError, logError, ThrowError, uuid } from "./Helpers.js";
import { User } from "../models/User.js";

const setJWT = async (userID: string) => {
	let currentUser: any = {};
	let error: Error | null = null;
	
	[error, currentUser] = await catchError(
		User.findById(userID, "username email role isActive").lean()
	);
	
	if (error) {
		logError('setJWT', error);
		ThrowError("An error occurred while fetching user information.");
	}
	
	if (!currentUser || !currentUser._id) {
		ThrowError("User token error.");
	}
	
	if (!currentUser.isActive) {
		ThrowError("Your account has been deactivated. Please contact support.");
	}

	// create jwt
	const accessToken = jwt.sign(
		{
			id: currentUser._id.toString(),
			email: currentUser.email,
			username: currentUser.username,
			role: currentUser.role
		},
		process.env.JWT_ACCESS_TOKEN_SECRET!,
		{
			expiresIn: +process.env.JWT_ACCESS_TOKEN_EXPIRES_IN * 60 * 1000,
		}
	);

	// Create refresh token
	const jwt_refresh_token_key = uuid();

	[error] = await catchError(
		User.findByIdAndUpdate(userID, {
			$push: { refreshTokens: jwt_refresh_token_key }
		})
	);
	
	if (error) {
		console.log(error);
		logError('setJWT', error);
		ThrowError("An error occurred while updating user information.");
	}

	const refreshcurrentUser = {
		id: currentUser._id.toString(),
		token: jwt_refresh_token_key,
	};
	const refreshToken = jwt.sign(
		refreshcurrentUser,
		process.env.JWT_REFRESH_TOKEN_SECRET!,
		{ expiresIn: +process.env.JWT_REFRESH_TOKEN_EXPIRES_IN * 24 * 60 * 60 * 1000 }
	);

	return { accessToken, refreshToken };
};

export default setJWT;

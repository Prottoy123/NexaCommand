import { OAuth2Client } from "google-auth-library";
import ApiError from "../utils/ApiError.js";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const verifyGoogleIdToken = async (idToken) => {
  try {
    const ticket = await client.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email_verified) {
      throw new ApiError(401, "Google account email is not verified.");
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      fullName: payload.name,
      avatarUrl: payload.picture || null,
    };
  } catch (error) {
    throw new ApiError(401, "Invalid or expired Google authentication token.");
  }
};
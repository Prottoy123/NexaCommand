import ApiError from "../utils/ApiError.js";

export const restrictTo = (allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user?.role)) {
      throw new ApiError(
        403,
        `Forbidden: Users with role '${req.user?.role}' do not have permission to access this route.`,
      );
    }
    next();
  };
};

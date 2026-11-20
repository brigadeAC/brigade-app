import { Navigate } from "react-router-dom";

// Expenses live in the Business Hub (Expenses tab). This old page stored a
// different record shape, so it now just sends people there.
export default function TrainerExpenses() {
  return <Navigate to="/BusinessHub" replace />;
}

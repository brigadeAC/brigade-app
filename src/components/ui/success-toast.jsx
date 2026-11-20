import { toast } from "sonner";

/**
 * Show a styled success popup for 3 seconds.
 * @param {string} message - The success message to display
 * @param {string} [description] - Optional description
 */
export function showSuccess(message, description) {
  toast.success(message, {
    description,
    duration: 3000,
    style: {
      background: "linear-gradient(135deg, #191615, #191615)",
      border: "1px solid rgba(75,145,221,0.4)",
      color: "#4B91DD",
      boxShadow: "0 0 20px rgba(75,145,221,0.2)",
    },
    classNames: {
      title: "text-primary font-bold",
      description: "text-primary/70",
      icon: "text-primary",
    },
  });
}
import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { PastDueNotice } from "./MemberBillingCard";
import { useBillingStatus, useMyBilling } from "./useBilling";

// Dashboard banner when a member's autopay failed. Nothing otherwise.
export default function BillingPastDueBanner() {
  const { data: status } = useBillingStatus();
  const { data } = useMyBilling(!!status?.connected);
  if (!status?.connected || !data?.past_due) return null;
  return <Link to={createPageUrl("Settings")} className="block"><PastDueNotice /></Link>;
}

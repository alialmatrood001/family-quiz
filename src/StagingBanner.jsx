import { clientEnvironment } from "./client-environment.js";
import "./staging-banner.css";

const stagingLabel = import.meta.env.VITE_STAGING_LABEL || "";

export default function StagingBanner() {
  if (!clientEnvironment.showStagingBanner || !stagingLabel) return null;
  return (
    <div className="staging-environment-banner" role="status">
      {stagingLabel}
    </div>
  );
}

import { requireAuth } from "./shared/authGuard.js";
import { renderNav } from "./shared/nav.js";

const session = await requireAuth();
if (session) {
  renderNav();
}

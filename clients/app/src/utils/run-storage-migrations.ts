// Account migrations run before account stores read localStorage.
// The composed web runtime runs its own assistant migrations separately.
import { runStorageMigrations } from "./storage-migration";
runStorageMigrations();

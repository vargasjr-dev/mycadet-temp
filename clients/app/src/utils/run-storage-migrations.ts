// Account migrations run before account stores read localStorage.
import { runStorageMigrations } from "./storage-migration";
runStorageMigrations();

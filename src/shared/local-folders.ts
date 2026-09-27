export interface LocalFolderListing {
  dir: string;
  parent: string | null;
  folders: { name: string; dir: string }[];
  truncated: boolean;
}

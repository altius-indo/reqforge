---
id: edit-and-bulk-update
title: Edit and bulk update
tabs:
keywords: drawer, record, create, new, save, delete, conflict, version, bulk, select, tags, dry run, import, csv, links, impact
---
Records are edited one at a time in the record drawer, or many at once with the bulk bar. Every save is versioned and
committed to the project's git repository.

### Edit one record

1. Click a row in any list to open the record drawer on the right. Its title shows the id and version, for example
   *v3*.
2. On the **Details** tab, change the fields. The form is generated from the record schema: list fields are
   comma-separated, and acceptance criteria and evals are JSON lists.
3. Click **Save**. A toast confirms the new version and the list refreshes.
4. If someone else saved the record after you opened it, the save is refused as a conflict: close the drawer, reopen
   the record to load the latest version, and edit again.
5. Press **Esc** or click **×** to close the drawer without saving.

### Create or delete a record

1. On the list for the kind you want, click **New**. The drawer opens with an empty form.
2. Fill in the required fields (marked **\***) and click **Create**.
3. To delete, open the record and click **Delete**, then **Click again to delete** to confirm.

### Review links and impact

1. Open a requirement and switch to the **Links & impact** tab.
2. Read the stories, tasks, evals and components that realise it, its parent and children, and which acceptance
   criteria each eval covers. Criteria *not covered by any eval* are shown in red.
3. Check the **Lint** list at the bottom for findings on this requirement.
4. Click any id to open that record in the drawer.

### Update many records at once

1. Tick the checkbox at the start of each row you want, or the checkbox in the header to select the whole page.
2. To act on every match of the current filters, click **Select all … matching** in the bulk bar.
3. In the bulk bar, choose the field, the mode (**set to**, **add to list** or **remove from list** — the list modes
   work on list fields such as tags) and the value.
4. Click **Dry run** to see how many records would change without writing anything.
5. Click **Apply** to write the change. Click **Clear** to drop the selection.

### Import from CSV

1. Click **Export CSV** to download the current view, and edit it in a spreadsheet (columns are field names).
2. Click **Import CSV** on the same list and pick the edited `.csv` file.
3. Rows with an existing id are updated; rows without one are created. A toast reports both counts.

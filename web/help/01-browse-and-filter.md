---
id: browse-and-filter
title: Browse and filter
tabs: requirements, epics, stories, tasks
keywords: list, search, tree, category, facet, filter, sort, page, crumbs, children, export, csv
---
Every record list (Requirements, Epics, Stories, Tasks, Components) shares the same toolbar, table and sidebar.
Filters combine: the tree, the facet chips and the search box all narrow the same list.

### Find requirements with the category tree

1. Open the **Requirements** tab in the header.
2. In the left sidebar under **Categories**, click a requirement type (for example *quality*). Its categories expand,
   each with a coverage bar showing how many of its requirements are linked to stories.
3. Click a category to show only its requirements. The breadcrumb above the table reads *All requirements › type ›
   category*.
4. A category marked **gap** has no requirement and no waiver; **waived** means the gap was accepted on purpose.
5. Click **All requirements** in the breadcrumb (or in the tree) to clear the drill-down.

### Search and filter

1. Type words into the search box above the table and press **Enter**.
2. Narrow by field with `field:value` tokens, for example `status:approved`, `tags:pci`, `priority:must` or
   `parent:` followed by a requirement id. Separate alternatives with `|`, as in `status:draft|proposed`.
3. Click a facet chip in the sidebar (status, priority, tags, …) to add it as a filter; click it again to remove it.
   On the Requirements tab, the **Traceability** chips show requirements *Not linked to a story* or *Linked*, and the
   **Verification** chips filter by verification status.
4. Each active filter appears as a pill next to the breadcrumb. Click the **×** on a pill to remove that filter.

### Sort, page and drill into children

1. Click a column header to sort by it; click again to reverse the order. An arrow marks the sorted column.
2. Use **Prev** / **Next** in the pager to move between pages, and its page-size menu to show 50, 100, 250 or 500
   rows per page. The pager also shows the range and the total, for example *1–100 of 3,040*.
3. On the Requirements tab, a red **0** in the *stories* column means no story realises that requirement.
4. Click the **▸** count in the *children* column to list that requirement's children.
5. Click any row to open the record drawer (see *Edit and bulk update*).

### Export the current view

1. Set up the filters and search you want.
2. Click **Export CSV**: the download contains exactly the rows that match the current view.

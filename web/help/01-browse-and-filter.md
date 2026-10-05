---
id: browse-and-filter
title: Browse and filter
tabs: requirements, epics, stories, tasks
keywords: list, search, tree, category, facet, filter, sort, page, crumbs, children, export, csv, sidebar, panel, resize, collapse, width
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

### Make room: collapse or resize the side panels

On wide screens you can give the list, the sidebar or the chat the space you need.

1. Click the **collapse** button at the top of the sidebar to shrink it to a narrow rail; click the rail's **expand**
   button to bring it back. Close the chat with its **×**; **Chat with Claude** in the header reopens it. The list
   takes the freed width.
2. Drag the inner edge of the sidebar (200–480 px) or the chat panel (320–720 px) to resize it. The list always keeps
   at least 480 px.
3. From the keyboard, Tab to the edge, then use the **arrow keys** (16 px a step), **Home** / **End** for the
   smallest / largest width, and **Enter** to collapse.
4. Double-click an edge to restore its default width (270 px sidebar, 410 px chat).

Widths and collapsed panels are remembered in this browser across reloads and projects. On narrow screens the
sidebar stays a slide-out sheet (the **☰** button) and the chat opens full-screen.

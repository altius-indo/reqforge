---
id: design
title: Design documents
tabs: design
keywords: design, spec, specification, architecture, how it is built, realises, markdown, design directory, slug
---
The **Design** tab shows how the system is built: design documents kept in the requirements repository, each linked
to the requirements it realises. Read them here instead of reading the code.

### Read a design document

1. Open the **Design** tab in the header.
2. Pick a document from the list on the left; documents are listed by title, in file-name order.
3. Read the document on the right. Under its title, **Realises** lists the requirements it builds.
4. Click any record id, in the **Realises** list or in the text, to open that record in the drawer.

### Find the design behind a requirement

1. Open the requirement in the drawer and choose the **Links & impact** tab.
2. Under **Design documents**, click a document's title to open it on the **Design** tab.

### Add a design document

1. In the requirements repository, create a Markdown file `design/<slug>.md`. The slug is lower-case letters, digits
   and `-`, starting with a letter or digit, for example `api`.
2. Start the file with front matter between `---` lines: `title:` and `realises:`, the list of requirement ids the
   document realises (written as `REQ-…`).
3. Write the body in GitHub-flavoured Markdown: headings, lists, tables and code blocks all render.
4. Commit the file (or click **Sync**), then open the **Design** tab. **Lint** reports any `realises` id that is not
   an existing requirement.

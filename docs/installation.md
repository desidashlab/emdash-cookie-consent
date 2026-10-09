## Three steps

1. In your EmDash admin open **Registry**, search for **Cookie Consent**, and click **Install**. It asks for no permissions.
2. Open **Cookie Consent** in the left menu, go to the **Setup** tab, and click **Download cookie-consent.js**. Put the file in your site's `public` folder.
3. Load it as the first script in the head of your base layout, before any analytics or marketing tag:

```astro
<head>
	<script is:inline src="/cookie-consent.js"></script>
	{/* everything else */}
</head>
```

If someone else built your site, send them the file and that one line.

The banner appears on every page right away. Wording, colours, layout, categories and the cookie list are all managed in the admin; the site picks up changes without touching the theme again.

<div align="center">
<img width="1079" height="670" alt="image" src="https://github.com/user-attachments/assets/80e72bd4-89b0-4ae0-8b7d-4e7f0a972e91" />
</div>

## intro
a gemini live demo ui, need set Gemini API Key or Use an [ephemeral token](https://ai.google.dev/gemini-api/docs/ephemeral-tokens) provided by your backend. 

## build with gemini <-> aistudio/apps builder <-> Antigravity
1. If you have questions, needs, or practical problems, you can directly submit them to Gemini (https://gemini.google.com/). Generally, you don't need any complex technical hints; Gemini will generate detailed design documents for your application development. (Questions are important, so get your curiosity going and discover the beauty in imperfections!)

2. Use https://aistudio.google.com/apps builder to build the prototype UI. The generated prototype project structure template is fixed, typically including directories like components, services (third-party API services, including the Gemini API), utils, and a homepage. The prototype UI design can provide image context for reference; hand-drawn images are fine. The generated results are generally very good, covering standard operations. Once all functional requirements are met, publish the project to GitHub or keep it locally for the next stage of development and building. (This is because there are differences between the builder and the actual development, testing, and production environments. For example, a page might display correctly in the builder, but in reality, the index page needs to be modified to display correctly.)

3. Use Antigravity https://antigravity.google/ for subsequent version iterations. For simple bug fixes, you can directly use Fast mode for very fast fixing, and it can be done using a browser (you need to install the Antigravity plugin). You can debug and replay completed tasks; it's a powerful tool for web development! Of course, Antigravity isn't limited to this; it can also be used for backend projects (backend project development from scratch can use gemini-cli; after defining the documentation, Antigravity can also be used. Whether combining the two can further improve efficiency requires further experimentation).

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

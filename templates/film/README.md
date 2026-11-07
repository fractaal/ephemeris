# {{name}}

An editable audiovisual project made with Ephemeris.

```sh
../../ephemeris serve          # the dev server (5320): http://localhost:5320/projects/{{name}}/
../../ephemeris nle {{name}}    # the editor (http://localhost:5340/p/{{name}}/)
../../ephemeris master {{name}} # the finished film into renders/
```

`film.js` is the film's visual and programmatic source. `timelines/main.json` holds its music, cues, fps and
shutter. Put music, voiceover, footage and images in `assets/`. `renders/` holds drafts and masters and
is not committed.

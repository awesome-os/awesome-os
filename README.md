# AwesomeOS
AwesomeOS started in 2015 as own linux distribution to experiment with Operating System Embedding. Today it evolved into a ECMAScript API that is integrateable into any ECMAScript Runtime.

## The AwesomeOS Fundamentals

```js
const awesomeOs = {
  prompt,
  exec
  io: {
   file
   dir
   net
   custommProtocols
  }
}
```

## Security Concepts
File Access requires always users attention 


## Usage
It is always minified it is always a es6+ module thats by design and should always be the case to be sure that scoping is correct.
If you need to transpil that to cjs add "use strict" at top of the entry file!
```js
import awesomeOs from 'https://awesome-os.com/dist/awesome-os.js'
```

## Next Steps?
add nativ AI and Multi Agent Capabilitys as also P2P Networking and more.

Use it in 
- Electron apps
- NWJS Apps
- Any Web Application
- Inject it into your existing browser websites and applications
- inject it into nodejs and graalvm backend services.
- Make more intelegent automated tests.
- Invent the next generation of Applications and the Whole web.



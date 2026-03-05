import net from 'node:net'

function proxy(listenPort, targetHost, targetPort) {
  net
    .createServer((client) => {
      const upstream = net.connect(targetPort, targetHost)

      client.pipe(upstream)
      upstream.pipe(client)

      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    .listen(listenPort, '0.0.0.0', () => {
      console.log(`Inspector proxy ${listenPort} → ${targetHost}:${targetPort}`)
    })
}

// test
proxy(9240, 'debug', 9240)

// auth
proxy(9229, 'auth', 9229)

// registry
proxy(9230, 'registry', 9230)

// data
proxy(9231, 'data', 9231)

// worker
proxy(9235, 'worker', 9235)

//  https
proxy(443, 'data', 443)

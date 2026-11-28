(ns acme.core.macros)

(defmacro defhandler
  "Defines a handler: a function of one request."
  [name args & body]
  `(defn ~name ~args ~@body))

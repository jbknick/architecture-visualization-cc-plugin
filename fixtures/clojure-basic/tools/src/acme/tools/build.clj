(ns acme.tools.build
  (:require [acme.core.util :as util]))

(defn clean [dir]
  (util/clamp (count dir) 0 1))

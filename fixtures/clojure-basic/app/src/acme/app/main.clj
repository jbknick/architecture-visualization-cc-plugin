(ns acme.app.main
  (:require [acme.core.shapes :as shapes]
            [acme.core.util :refer [clamp]]
            [acme.core.macros :as m]
            [acme.app.report :refer :all])
  (:gen-class))

(m/defhandler on-ping [req]
  {:status 200 :body (str (:uri req))})

(defn run [args]
  (let [c (shapes/circle (clamp (count args) 1 10))]
    (print-report [c (shapes/unit)])
    (shapes/area c)))

(defn -main [& args]
  (run args))

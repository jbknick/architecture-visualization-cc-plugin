(ns acme.core.shapes
  "Shapes and their areas."
  (:require [acme.core.util :as u]))

(defprotocol Shape
  (area [this] "The area of the shape.")
  (describe [this]))

(defrecord Circle [r]
  Shape
  (area [_] (* Math/PI (u/square r)))
  (describe [this] (str "circle of area " (area this))))

(defn circle
  "A circle of radius `r`, kept between 0 and 100."
  [r]
  (->Circle (u/clamp r 0 100)))

(defn- unit-radius [] 1)

(defn unit [] (circle (unit-radius)))

(defmulti scale (fn [shape _] (type shape)))

(defmethod scale Circle [c k]
  (circle (* k (:r c))))
